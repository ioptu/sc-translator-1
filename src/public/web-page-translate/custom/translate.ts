// 文件路径示例: ./src/public/web-page-translate/custom/translate.ts

import { WebpageTranslateFn } from '..';
import { SOURCE_ERROR } from '../../../constants/errorCodes';
// 假设 types 也在 constants 目录下
import * as types from '../../../constants/chromeSendMessageTypes'; 
import scOptions from '../../sc-options';
import { RESULT_ERROR, LANGUAGE_NOT_SOPPORTED } from '../../translate/error-codes';
// 假设 getError 仍在 utils 中，我们不再需要 fetchData
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
        translatedTexts: any[]; 
        sourceLanguage: string;
        targetLanguage: string;
    };
    message?: string;
};

// 模拟 Response 结构，用于适配 try/catch 逻辑
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
        
        // 发送消息给后台 Service Worker
        chrome.runtime.sendMessage({
            type: types.SCTS_CUSTOM_API_PROXY, // 使用新的消息类型
            payload: { url, options }
        }, (response) => {
            // 检查 Chrome runtime 错误（如端口关闭）
            if (chrome.runtime.lastError) {
                return reject(new Error('Extension messaging error: ' + chrome.runtime.lastError.message));
            }
            // 检查后台脚本返回的自定义错误
            if (response.error) {
                return reject(new Error(`Proxy Fetch Error: ${response.error}`));
            }

            // 构造一个模拟 Response 对象
            const mockResponse: MockResponse = {
                ok: response.ok,
                status: response.status,
                json: () => Promise.resolve(response.data) // 直接返回解析后的数据
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
    
    // 参数类型转换
    const translatorCodeValue = parseInt(rawTranslatorCode.replace(/"/g, ''), 10) || 0; 
    const promptBuilderCodeValue = parseInt(rawPromptBuilderCode.replace(/"/g, ''), 10) || 0; 
    
    const authorizationHeaderValue = authorizationToken.startsWith('Bearer ') 
        ? authorizationToken 
        : `Bearer ${authorizationToken}`;
    
    // 2. 语言代码和 Header 构造
    const finalUrl = baseUrl; // 使用剥离参数后的 Base URL

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

    // 4. 发送请求 - 🚨 使用代理函数
    const res = await proxyFetchData(finalUrl, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(fetchJSON)
    });

    try {
        // 5. 处理响应
        if (!res.ok) {
            // 如果 HTTP 状态码不是 2xx，抛出错误
            throw new Error(`Proxy request failed with status: ${res.status}`);
        }
        
        const responseData: CustomApiResponse = await res.json();

        // 6. 适配 API 响应解析
        if (responseData.code !== 'S000000' || !responseData.data) {
            const errorMessage = responseData.message || 'API返回非成功状态码';
            throw getError(responseData.code || RESULT_ERROR, `网页翻译失败: ${errorMessage}`);
        }
        
        const data = responseData.data;
        const finalResultArray = data.texts;

        if (!finalResultArray) {
             throw getError(RESULT_ERROR, 'API 响应中缺少 translatedTexts 字段。');
        }

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
            // 如果是代理错误或 JSON 解析错误，将其封装成 RESULT_ERROR
            throw getError(RESULT_ERROR, error.message || '未知翻译错误。');
        }
    }
};
