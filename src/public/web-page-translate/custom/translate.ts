// 文件路径示例: ./src/public/web-page-translate/custom/translate.ts

import { WebpageTranslateFn } from '..';
import { SOURCE_ERROR } from '../../../constants/errorCodes';
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
        texts?: { id: string, translation: string }[]; // 匹配实际 API 响应
        sourceLanguage: string;
        targetLanguage: string;
    };
    message?: string;
};

// 官方要求的最终返回类型 (为了方便，我们直接构建 finalResult)
type FinalResultItem = {
    translations: string[]; 
    comparisons?: string[];
};

type MockResponse = {
    json: () => Promise<CustomApiResponse>;
    status: number;
    ok: boolean;
};

// ... (proxyFetchData 和其他辅助函数保持不变) ...

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
    // ⭐️ 核心修正：paragraphs 是 string[][] 类型。我们现在使用 flat() 后的数组来构造 API 请求。
    const paragraphsArray = Array.isArray(paragraphs) ? paragraphs : [];
    const flattenedParagraphs = paragraphsArray.flat(); // 获取扁平化后的原始文本列表

    const textsForApi = flattenedParagraphs.map((content, index) => {
        const cleanedContent = (content || '').trim();
        return {
            id: `0-${index}`, 
            content: cleanedContent || '.' // 使用占位符保持长度
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
        const rawResultArray = data.texts; 
        
        if (!rawResultArray) {
             throw getError(RESULT_ERROR, 'API 响应中缺少 texts 字段。');
        }
        
        // 关键校验：检查 API 返回的扁平化数组长度是否与发送的扁平化数组长度一致
        if (rawResultArray.length !== flattenedParagraphs.length) {
            throw getError(RESULT_ERROR, `API 返回的翻译结果数 (${rawResultArray.length}) 与发送的段落数 (${flattenedParagraphs.length}) 不匹配。`);
        }

        // 7. 构造最终结果数组 (Final Result Array)
        
        // 1. 提取扁平化的翻译文本 (string[])
        const flatTranslations = rawResultArray.map(item => (item && item.translation) || '');
        
        // 2. 将扁平化的翻译结果重构为原始的嵌套结构，
        //    并将其包装成官方要求的 FinalResultItem 对象 { translations: [string] }
        let flatIndex = 0;
        const finalResult: FinalResultItem[] = paragraphsArray.map((row) => {
            const translationsForRow: string[] = [];
            
            // row 是原始段落数组中的一行，它本身是一个 string[]
            for (let i = 0; i < row.length; i++) {
                if (flatIndex < flatTranslations.length) {
                    // 从扁平化的翻译结果中取出对应项
                    translationsForRow.push(flatTranslations[flatIndex]); 
                    flatIndex++;
                } else {
                    // 安全回退，不应该发生
                    translationsForRow.push(""); 
                }
            }
            
            // ⭐️ 必须返回 { translations: string[] } 对象，且对象数组长度必须与 paragraphsArray 相同 ⭐️
            return {
                translations: translationsForRow 
            } as FinalResultItem;
        });

        // 8. 校验最终结果 (check-result.ts 当前为空操作)
        checkResultFromCustomWebpageTranslatSource({ result: finalResult }); 
        
        // 9. 返回最终的嵌套结果数组
        // 官方文档要求返回 { result: FinalResultItem[] } 或 { code: string }
        // 假设您的 WebpageTranslateFn 类型定义期望返回的是 result 数组本身
        // 如果您的项目期望的是 { result: [] }，请自行添加包装
        return finalResult;
        
        /* 如果您的 WebpageTranslateFn 期望返回的是 { result: [] } 对象，
        请使用以下代码代替 return finalResult; 这一行：
        return { result: finalResult };
        */
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
