// 文件路径示例: ./src/public/web-page-translate/custom/translate.ts

import { WebpageTranslateFn } from '..';
import { SOURCE_ERROR } from '../../../constants/errorCodes';
// 假设 types 在 constants 目录下
import * as types from '../../../constants/chromeSendMessageTypes'; 
import scOptions from '../../sc-options';
import { RESULT_ERROR, LANGUAGE_NOT_SOPPORTED } from '../../translate/error-codes';
import { getError } from '../../translate/utils'; 
import { checkResultFromCustomWebpageTranslatSource } from './check-result';
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
        translatedTexts?: any[]; // 保留兼容性，但实际使用 texts
        texts?: any[];         // 匹配实际 API 响应
        sourceLanguage: string;
        targetLanguage: string;
    };
    message?: string;
};

type MockResponse = {
    json: () => Promise<CustomApiResponse>;
    status: number;
    ok: boolean;
};

const getNormalizedLangCode = (apiCode: string, defaultValue: string = 'auto'): string => {
    return (apiCode in langCode) ? apiCode : defaultValue; 
};

/**
 * 🚨 核心改动：通过 chrome.runtime.sendMessage 调用 Background Script 代理请求
 */
const proxyFetchData = (url: string, options: any): Promise<MockResponse> => {
    return new Promise((resolve, reject) => {
        
        chrome.runtime.sendMessage({
            type: types.SCTS_CUSTOM_API_PROXY, 
            payload: { url, options }
        }, (response) => {
            if (chrome.runtime.lastError) {
                return reject(new Error('Extension messaging error: ' + chrome.runtime.lastError.message));
            }
            if (response.error) {
                return reject(new Error(`Proxy Fetch Error: ${response.error}`));
            }

            const mockResponse: MockResponse = {
                ok: response.ok,
                status: response.status,
                json: () => Promise.resolve(response.data) 
            };
            
            resolve(mockResponse);
        });
    });
};


// ----------------------------------------------------------------------
// 主函数
// ----------------------------------------------------------------------

export const translate: WebpageTranslateFn = async ({ paragraphs, targetLanguage }, source) => {
    const { customWebpageTranslateSourceList } = await scOptions.get(['customWebpageTranslateSourceList']);
    const customTranslateSource = customWebpageTranslateSourceList.find(value => value.source === source);

    if (!customTranslateSource) { throw getError(SOURCE_ERROR); }

    // 1. URL 解析和自定义参数提取 (保持不变)
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
    const rawTranslatorCode = extractedParams['tc'] || '0'; 
    const rawPromptBuilderCode = extractedParams['pbc'] || '0'; 
    const clientOrigin = extractedParams['org'] || navigator.language || 'zh-CN'; 
    
    const translatorCodeValue = parseInt(rawTranslatorCode.replace(/"/g, ''), 10) || 0; 
    const promptBuilderCodeValue = parseInt(rawPromptBuilderCode.replace(/"/g, ''), 10) || 0; 
    
    const authorizationHeaderValue = authorizationToken.startsWith('Bearer ') 
        ? authorizationToken 
        : `Bearer ${authorizationToken}`;
    
    // 2. 语言代码和 Header 构造 (保持不变)
    const finalUrl = baseUrl; 

    if (!(targetLanguage in langCode)) { throw getError(LANGUAGE_NOT_SOPPORTED); }

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': authorizationHeaderValue,
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
    // ⭐️ 修正点 1：确保 paragraphs 是一个有效的数组，以防止 .flat() 崩溃 ⭐️
    const paragraphsArray = Array.isArray(paragraphs) ? paragraphs : [];

    const textsForApi = paragraphsArray.flat().map((content, index) => ({
        id: `0-${index}`, 
        content: content || ''
    }));

    const fetchJSON: ApiRequestJSON = { 
        texts: textsForApi,
        targetLanguage: langCode[targetLanguage],
        translatorCode: translatorCodeValue,
        promptBuilderCode: promptBuilderCodeValue,
    };

    // 4. 发送请求 - 🚨 使用代理函数
    const res = await proxyFetchData(finalUrl, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(fetchJSON)
    });

    try {
        // 5. 处理响应
        if (!res.ok) {
            throw new Error(`Proxy request failed with status: ${res.status}`);
        }
        
        const responseData: CustomApiResponse = await res.json();

        // 6. 适配 API 响应解析
        if (responseData.code !== 'S000000' || !responseData.data) {
            const errorMessage = responseData.message || 'API返回非成功状态码';
            throw getError(responseData.code || RESULT_ERROR, `网页翻译失败: ${errorMessage}`);
        }
        
        const data = responseData.data;
        // ⭐️ 修正点 2：使用 API 实际返回的字段名 'texts' ⭐️
        const rawResultArray = data.texts; 
        
        if (!rawResultArray) {
             throw getError(RESULT_ERROR, 'API 响应中缺少 texts 字段。');
        }
        
        // ⭐️ 修正点 3：从 {id, translation}[] 数组中提取最终的翻译文本 string[] ⭐️
        const finalResultArray = rawResultArray.map(item => (item && item.translation) || '');


        // 7. 校验最终结果
        checkResultFromCustomWebpageTranslatSource({ result: finalResultArray }); 
        
        // 8. 返回最终的翻译结果数组
        return finalResultArray; 
    }
    catch (err) {
        const error = err as ReturnType<typeof getError> | Error;
        if ('code' in error && error.code) {
            throw error;
        }
        else {
            console.error("Unexpected translation error:", err);
            throw getError(RESULT_ERROR, error.message || '未知翻译错误。');
        }
    }
};
