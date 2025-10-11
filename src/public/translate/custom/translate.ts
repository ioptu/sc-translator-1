import { SOURCE_ERROR } from '../../../constants/errorCodes';
import { TranslateResult } from '../../../types';
import { TranslateParams } from '../translate-types';
import { fetchData, getError } from '../utils';
import { langCode } from '../google/lang-code';
import { LANGUAGE_NOT_SOPPORTED, RESULT_ERROR } from '../error-codes';
import { checkResultFromCustomSource } from './check-result';
import scOptions from '../../sc-options';

// ----------------------------------------------------------------------
// 辅助类型定义 (为了代码完整性，但实际可能在其他文件)
// ----------------------------------------------------------------------

type FetchCustomSourceJSON = {
    text: string;
    from: string;
    to: string;
    userLang: string;
    preferred: [string, string];
};

// 定义新的 API 响应结构 (简化版)
type CustomApiResponse = {
    code: string;
    data?: {
        sourceLanguage: string;
        targetLanguage: string;
        texts: { id: string, translation: string }[];
        translatorCode: number;
    };
    debugMessage?: string;
    message?: string;
};

// ----------------------------------------------------------------------
// 主函数
// ----------------------------------------------------------------------

export const translate = async ({ text, from, to, preferredLanguage, secondPreferredLanguage }: TranslateParams, source: string): Promise<TranslateResult> => {
    
    // 1. 获取自定义源配置
    const { customTranslateSourceList } = await scOptions.get(['customTranslateSourceList']);
    const customTranslateSource = customTranslateSourceList.find(value => value.source === source);

    if (!customTranslateSource) { throw getError(SOURCE_ERROR); }

    // ====== URL 解析和自定义参数提取 ======
    const urlString = customTranslateSource.url;
    const questionMarkIndex = urlString.indexOf('?');
    
    let baseUrl = urlString;
    let extractedParams = {}; 

    if (questionMarkIndex !== -1) {
        baseUrl = urlString.substring(0, questionMarkIndex);
        const paramsString = urlString.substring(questionMarkIndex + 1);
        
        paramsString.split('&').forEach(pair => {
            const [key, value] = pair.split('=');
            if (key) {
                let rawKey = decodeURIComponent(key);
                let rawValue = value || ''; 
                extractedParams[rawKey] = decodeURIComponent(rawValue);
            }
        });
    }

    const authorizationToken = extractedParams['key'] || ''; 
    const translatorCodeValue = extractedParams['tc'] || '';
    const promptBuilderCodeValue = extractedParams['pbc'] || 0; 
    
    const authorizationHeaderValue = authorizationToken.startsWith('Bearer ') 
        ? authorizationToken 
        : `Bearer ${authorizationToken}`;
    // ===================================

    // 2. 语言代码处理和校验
    const originTo = to;
    const originFrom = from;

    from = from || 'auto';
    to = to || (from === preferredLanguage ? secondPreferredLanguage : preferredLanguage);

    if (!(from in langCode) || !(to in langCode)) { throw getError(LANGUAGE_NOT_SOPPORTED); }

    // 3. 构造 Headers
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': authorizationHeaderValue,
        "accept": "*/*",
        "accept-language": navigator.language || "zh-CN",
        "x-browser-language": navigator.language || "zh-CN",
    };

    // 4. 构造请求 Body (fetchJSON) 
    let fetchJSON = {
        targetLanguage: langCode[to], 
        translatorCode: translatorCodeValue,
        promptBuilderCode: promptBuilderCodeValue,
        texts: [ 
            { id: '0-0', content: text } 
        ]
    };
    
    // 5. 第一次翻译请求
    const res = await fetchData(baseUrl, { 
        method: 'POST',
        headers: headers,
        body: JSON.stringify(fetchJSON)
    });

    try {
        // ⭐️ 核心修改 1: 声明 data 的类型以匹配 API 响应 ⭐️
        let responseData: CustomApiResponse = await res.json(); 
        
        // ⭐️ 核心修改 2: 检查自定义 API 状态码 ⭐️
        if (responseData.code !== 'S000000' || !responseData.data) {
            // 如果 API 返回的 code 不是成功，或者 data 字段缺失
            // 尝试使用 API 提供的 message 或 code 抛出错误
            throw getError(responseData.code || RESULT_ERROR, responseData.message || 'API返回非成功状态码');
        }

        // 提取实际数据
        let data = responseData.data;
        
        // 由于结构已确定，我们不再需要通用的 checkResultFromCustomSource，
        // 但如果它包含更复杂的业务逻辑校验，则保留。
        // checkResultFromCustomSource(data); 

        // 6. 自动切换目标语言 (二次请求逻辑)
        // 注意：现在 sourceLanguage 和 targetLanguage 在 data 内部
        const sourceLangFromApi = data.sourceLanguage;
        const targetLangFromApi = data.targetLanguage;
        
        if (!originFrom && !originTo && sourceLangFromApi === targetLangFromApi && preferredLanguage !== secondPreferredLanguage) {
            to = secondPreferredLanguage;

            // 构造新的请求体，仅更新目标语言
            const newFetchJSON = { 
                ...fetchJSON, 
                targetLanguage: langCode[to]
            };

            const newRes = await fetchData(baseUrl, { 
                method: 'POST',
                headers: headers,
                body: JSON.stringify(newFetchJSON)
            });

            // ⭐️ 核心修改 3: 处理二次请求的响应 ⭐️
            responseData = await newRes.json();
            
            if (responseData.code !== 'S000000' || !responseData.data) {
                 throw getError(responseData.code || RESULT_ERROR, responseData.message || 'API返回非成功状态码 (二次请求)');
            }
            data = responseData.data;
            // checkResultFromCustomSource(data);
        }
        
        // 7. 构造最终结果
        const translatedText = data.texts[0]?.translation || ''; // 提取翻译结果

        const result: TranslateResult = {
            text, // 原始文本
            from: data.sourceLanguage, // 使用 API 报告的源语言
            to, // 使用最终目标语言
            result: [translatedText], // 将翻译结果包装成数组
            // 以下字段缺失，但保留在 TranslateResult 中
            dict: undefined,
            phonetic: undefined,
            related: undefined,
            example: undefined
        };

        return result;
    }
    catch (err) {
        // 8. 错误处理
        if ((err as ReturnType<typeof getError>).code) {
            throw err; 
        }
        else {
            // 如果是 JSON 解析或其他未知错误，抛出 RESULT_ERROR
            throw getError(RESULT_ERROR); 
        }
    }
};
