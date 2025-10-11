import { langCodeI18n } from '../../../constants/langCode';
import { defaultGeminiValue } from '../../../constants/thirdPartyServiceValues';
import { TranslateResult } from '../../../types';
import { getMessage } from '../../i18n';
import scOptions from '../../sc-options';
import { RESULT_ERROR } from '../error-codes';
import { TranslateParams } from '../translate-types';
import { determineFromAndTo, fetchTPS, getError } from '../utils';

export const translate: (params: TranslateParams) => Promise<TranslateResult> = async ({ text, from, to, preferredLanguage, secondPreferredLanguage }) => {
    // ... (1. 确定 from/to 逻辑保持不变)
    const { from: nextFrom, to: nextTo } = await determineFromAndTo({ text, from, to, preferredLanguage, secondPreferredLanguage });
    from = nextFrom;
    to = nextTo;

    if (!to) { throw getError('Error: Unable to determine a target language, please provide the target language.'); }

    const { enabledThirdPartyServices: services } = await scOptions.get(['enabledThirdPartyServices']);
    // 查找服务名保持不变 ('Gemini')
    const currentService = services.find(service => service.name === 'Gemini'); 

    if (!currentService) { throw getError('Error: Service value not found.'); }

    // **【关键修复点】**：移除导致 SyntaxError 的注释和额外的逗号
    const serviceValue = { ...defaultGeminiValue, ...currentService }; 
    
    // 检查 Auth Token (使用 key)
    if (!serviceValue.key) { throw getError('Error: Auth Token (key) is required.'); }
    
    // URL 直接使用配置中的完整 URL (包含 Account ID)
    const url = serviceValue.url;
    
    // Prompt 策略（适配 LLM 翻译）
    const prompt = `Translate the following text into ${langCodeI18n['zh-CN'][to]}: "${text}"`;

    // 请求 Body 结构 (Cloudflare AI)
    const fetchJSON = { 
        model: serviceValue.model, 
        input: prompt             
    };

    const res = await fetchTPS(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            // 认证 Header
            'Authorization': `Bearer ${serviceValue.key}` 
        },
        body: JSON.stringify(fetchJSON)
    });

    try {
        const result = await res.json();
        
        // 检查 HTTP 状态和 Cloudflare 的 success 标志
        if (!res.ok || result.success === false) {
            // 适配 Cloudflare 错误信息提取路径
            const errorDetails = (result.errors || result.messages || [{message: 'Unknown API Error'}])
                                 .map(e => e.message).join('; ');
            throw getError(`Cloudflare AI API Error: ${errorDetails}`);
        }

        // 🎯 返回完整的 JSON 响应字符串
        // 假设 TranslateResult 的 result 字段只能是 string[]
        const jsonResultString = JSON.stringify(result, null, 2); 

        return {
            text,
            from,
            to,
            // 结果字段包含整个 JSON 响应的字符串表示
            result: [jsonResultString] 
        };
        
    }
    catch (err) {
        // ... (错误处理逻辑保持不变)
        if ((err as ReturnType<typeof getError>).code) {
            throw err;
        }
        else {
            throw getError(RESULT_ERROR);
        }
    }
};
