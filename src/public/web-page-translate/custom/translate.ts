// 文件路径示例: ./src/public/web-page-translate/custom/translate.ts

import { WebpageTranslateFn } from '..';
import { SOURCE_ERROR } from '../../../constants/errorCodes';
import scOptions from '../../sc-options';
import { RESULT_ERROR, LANGUAGE_NOT_SOPPORTED } from '../../translate/error-codes';
// 假设 fetchData 和 getError 来自这个路径
import { fetchData, getError } from '../../translate/utils'; 
import { checkResultFromCustomWebpageTranslatSource } from './check-result';
// 假设 langCode 位于这个路径
import { langCode } from '../../translate/google/lang-code';


// ----------------------------------------------------------------------
// 类型定义和辅助函数
// ----------------------------------------------------------------------

type ApiRequestJSON = {
    texts: { id: string, content: string }[]; 
    targetLanguage: string;
    translatorCode: number;
    promptBuilderCode: number;
};

type CustomApiResponse = {
    code: string;
    data?: {
        translatedTexts: any[]; 
        sourceLanguage: string;
        targetLanguage: string;
    };
    message?: string;
};

const getNormalizedLangCode = (apiCode: string, defaultValue: string = 'auto'): string => {
    return (apiCode in langCode) ? apiCode : defaultValue; 
};


// ----------------------------------------------------------------------
// 主函数
// ----------------------------------------------------------------------

export const translate: WebpageTranslateFn = async ({ paragraphs, targetLanguage }, source) => {
    const { customWebpageTranslateSourceList } = await scOptions.get(['customWebpageTranslateSourceList']);
    const customTranslateSource = customWebpageTranslateSourceList.find(value => value.source === source);

    if (!customTranslateSource) { throw getError(SOURCE_ERROR); }

    // 1. URL 解析和自定义参数提取
    const urlString = customTranslateSource.url;
    const questionMarkIndex = urlString.indexOf('?');
    
    let baseUrl = urlString;
    let extractedParams = {}; 

    if (questionMarkIndex !== -1) {
        baseUrl = urlString.substring(0, questionMarkIndex); // 剥离参数后的 Base URL
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
    const rawTranslatorCode = extractedParams['tc'] || '0'; 
    const rawPromptBuilderCode = extractedParams['pbc'] || '0'; 
    const clientOrigin = extractedParams['org'] || navigator.language || 'zh-CN'; 
    
    // 参数类型转换 (解决 S000001 错误)
    const translatorCodeValue = parseInt(rawTranslatorCode.replace(/"/g, ''), 10) || 0; 
    const promptBuilderCodeValue = parseInt(rawPromptBuilderCode.replace(/"/g, ''), 10) || 0; 
    
    const authorizationHeaderValue = authorizationToken.startsWith('Bearer ') 
        ? authorizationToken 
        : `Bearer ${authorizationToken}`;
    
    // 2. 语言代码和 Header 构造
    const finalUrl = baseUrl; // 最终请求 URL 使用剥离参数后的 Base URL

    if (!(targetLanguage in langCode)) { throw getError(LANGUAGE_NOT_SOPPORTED); }

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': authorizationHeaderValue,
        // 增加 X-Client-Origin 头部 (用于 API 业务逻辑识别，非 CORS 解决方案)
        "X-Client-Origin": clientOrigin,
        "accept": "*/*",
        "accept-language": navigator.language || "zh-CN",
        "x-browser-language": navigator.language || "zh-CN",
        "priority": "u=1, i",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "none",
        "x-client-version": "1.6.7",
    };

    // 3. 构造请求 Body
    // 将 string[][] 扁平化并适配 API 期望的 texts: {id: string, content: string}[] 结构
    const textsForApi = paragraphs.flat().map((content, index) => ({
        id: `0-${index}`, 
        content: content || ''
    }));

    const fetchJSON: ApiRequestJSON = { 
        texts: textsForApi,
        targetLanguage: langCode[targetLanguage],
        translatorCode: translatorCodeValue,
        promptBuilderCode: promptBuilderCodeValue,
    };

    // 4. 发送请求
    const res = await fetchData(finalUrl, { // 使用剥离参数后的 finalUrl
        method: 'POST',
        headers: headers,
        body: JSON.stringify(fetchJSON)
    });

    try {
        const responseData: CustomApiResponse = await res.json();

        // 5. 适配 API 响应解析
        if (responseData.code !== 'S000000' || !responseData.data) {
            const errorMessage = responseData.message || 'API返回非成功状态码';
            throw getError(responseData.code || RESULT_ERROR, `网页翻译失败: ${errorMessage}`);
        }
        
        const data = responseData.data;
        const finalResultArray = data.translatedTexts;

        if (!finalResultArray) {
             throw getError(RESULT_ERROR, 'API 响应中缺少 translatedTexts 字段。');
        }

        // 6. 校验最终结果 - 封装 API 结果以满足校验函数的 { result: T[] } 要求
        checkResultFromCustomWebpageTranslatSource({ result: finalResultArray }); 
        
        // 7. 返回最终的翻译结果数组
        return finalResultArray; 
    }
    catch (err) {
        const error = err as ReturnType<typeof getError>;
        if (error.code) {
            throw error;
        }
        else {
            console.error("Unexpected translation error:", err);
            throw getError(RESULT_ERROR);
        }
    }
};
