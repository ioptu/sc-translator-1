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
        translatedTexts?: any[]; 
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
 * 通过 chrome.runtime.sendMessage 调用 Background Script 代理请求
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
    // 确保 paragraphs 是一个有效的数组
    const paragraphsArray = Array.isArray(paragraphs) ? paragraphs : [];

    // ⭐️ 核心修正点：确保输入内容非空，防止 API 忽略导致数组长度不匹配 ⭐️
    const textsForApi = paragraphsArray.flat().map((content, index) => {
        const cleanedContent = (content || '').trim();
        
        return {
            id: `0-${index}`, 
            // 如果清理后为空，使用一个最小的非空占位符（如 '.'），以确保 API 返回一个匹配的翻译结果
            content: cleanedContent || '.' 
        };
    });

    const fetchJSON: ApiRequestJSON = { 
        texts: textsForApi,
        targetLanguage: langCode[targetLanguage],
        translatorCode: translatorCodeValue,
        promptBuilderCode: promptBuilderCodeValue,
    };

    // 4. 发送请求 - 使用代理函数
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
        // 使用 API 实际返回的字段名 'texts' 
        const rawResultArray = data.texts; 
        
        if (!rawResultArray) {
             throw getError(RESULT_ERROR, 'API 响应中缺少 texts 字段。');
        }
        
        // 从 {id, translation}[] 数组中提取最终的翻译文本 string[]
        const finalResultArray = rawResultArray.map(item => {
            const translation = (item && item.translation) || '';
            // 如果我们发送了占位符 '.'，则返回空字符串，而不是翻译后的 '.' 
            // (这是可选的，取决于您是否想要返回翻译后的句号)
            // 这里我们保持返回翻译后的结果，如果 API 翻译 '.' 为 '.'，则返回 '.' 
            return translation; 
        });


        // 7. 校验最终结果 (check-result.ts 当前为空操作)
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
