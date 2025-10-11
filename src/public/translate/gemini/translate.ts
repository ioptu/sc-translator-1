import { langCodeI18n } from '../../../constants/langCode';
import { defaultGeminiValue } from '../../../constants/thirdPartyServiceValues';
import { TranslateResult } from '../../../types';
import { getMessage } from '../../i18n';
import scOptions from '../../sc-options';
import { RESULT_ERROR } from '../error-codes';
import { TranslateParams } from '../translate-types';
import { determineFromAndTo, fetchTPS, getError } from '../utils';
//这其实是cloudflare ai 的@cf/openai/gpt-oss-20b模型
export const translate: (params: TranslateParams) => Promise<TranslateResult> = async ({ text, from, to, preferredLanguage, secondPreferredLanguage }) => {
    // 1. 确定源语言和目标语言
    const { from: nextFrom, to: nextTo } = await determineFromAndTo({ text, from, to, preferredLanguage, secondPreferredLanguage });
    from = nextFrom;
    to = nextTo;

    if (!to) { throw getError('Error: Unable to determine a target language, please provide the target language.'); }

    // 2. 获取服务配置
    const { enabledThirdPartyServices: services } = await scOptions.get(['enabledThirdPartyServices']);
    // 保持服务名为 'Gemini'
    const currentService = services.find(service => service.name === 'Gemini'); 

    if (!currentService) { throw getError('Error: Service value not found.'); }

    // 修复 SyntaxError，并合并默认值
    const serviceValue = { ...defaultGeminiValue, ...currentService }; 
    
    // 3. 参数检查和 URL/Prompt 准备
    // 检查 Auth Token (使用 key)
    if (!serviceValue.key) { throw getError('Error: Auth Token (key) is required.'); }
    
    // URL 直接使用配置中的完整 URL (包含 Account ID)
    const url = serviceValue.url;
    
    // Prompt 策略（适配 Cloudflare LLM 翻译）
    const prompt = `Translate the following text into ${langCodeI18n['zh-CN'][to]}: "${text}"`;

    // 4. 请求 Body 结构 (Cloudflare AI)
    // 结构为：{ model: "...", input: "..." }
    const fetchJSON = { 
        model: serviceValue.model, // Cloudflare 模型名称
        input: prompt             
    };

    // 5. 调用第三方服务 API
    const res = await fetchTPS(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            // 认证 Header: 使用 serviceValue.key 作为 Bearer Token
            'Authorization': `Bearer ${serviceValue.key}` 
        },
        body: JSON.stringify(fetchJSON)
    });

    try {
        const result = await res.json();
        
        // 6. 响应处理和错误检查
        // 检查 HTTP 状态和 Cloudflare 的 success 标志
        if (!res.ok || result.success === false) {
            // 适配 Cloudflare 错误信息提取路径
            const errorDetails = (result.errors || result.messages || [{message: 'Unknown API Error'}])
                                 .map(e => e.message).join('; ');
            throw getError(`Cloudflare AI API Error: ${errorDetails}`);
        }

        // 7. 提取翻译结果 (根据 Cloudflare 实际 JSON 结构)
        // 查找 type: "message" 且 role: "assistant" 的输出块
        const translationContainer = result.output.find((item: any) => item.type === 'message' && item.role === 'assistant');
        
        if (!translationContainer || !translationContainer.content || !translationContainer.content[0] || !translationContainer.content[0].text) {
             // 如果找不到预期的翻译文本路径，则抛出错误
             throw getError(`Cloudflare AI response structure is invalid for translation.`);
        }
        
        const translation: string = translationContainer.content[0].text; 
        
        // 可选：移除翻译文本末尾的标点符号，以获得更干净的结果 
        const cleanTranslation = translation.trim().replace(/[。？！，：；“”]$/, '');


        return {
            text,
            from,
            to,
            // 将翻译结果按行分割返回
            result: cleanTranslation.split('\n') 
        };
        
    }
    catch (err) {
        // 8. 错误捕获和抛出
        if ((err as ReturnType<typeof getError>).code) {
            throw err;
        }
        else {
            throw getError(RESULT_ERROR);
        }
    }
};
