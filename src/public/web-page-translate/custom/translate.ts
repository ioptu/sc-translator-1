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

const proxyFetchData = (url: string, options: any): Promise<MockResponse> => {
    return new Promise((resolve, reject) => {
        
        chrome.runtime.sendMessage({
            type: types.SCTS_CUSTOM_API_PROXY, 
            payload: { url, options }
        }, (response) => {
            if (chrome.runtime.lastError) {
                // 处理消息端口关闭等问题
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
    const paragraphsArray = Array.isArray(paragraphs) ? paragraphs : [];
    const flattenedParagraphs = paragraphsArray.flat(); // 原始扁平化文本列表 (全量)

    // ⭐️ 核心逻辑：过滤无效内容 ⭐️
    const textsForApi: ApiRequestJSON['texts'] = [];
    const validContentIndices: number[] = []; // 记录发送给 API 的内容在 'flattenedParagraphs' 中的原始索引

    flattenedParagraphs.forEach((content, index) => {
        const cleanedContent = (content || '').trim();
        
        // 判定标准：如果内容长度小于 3 且不包含字母或中文，则认为是无效的纯标点/数字，跳过发送给 API。
        const isPurePunctuationOrShort = cleanedContent.length > 0 && !/[a-zA-Z\u4e00-\u9fa5]/.test(cleanedContent) && cleanedContent.length < 3;

        if (cleanedContent.length === 0 || isPurePunctuationOrShort) {
            // 跳过发送给 API
        } else {
            // 有效内容，添加到请求中
            textsForApi.push({
                id: `0-${index}`, 
                content: cleanedContent 
            });
            validContentIndices.push(index); // 记录有效内容的原始索引
        }
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
        
        // 校验：API 返回的有效结果数是否与发送的有效内容数匹配
        if (rawResultArray.length !== textsForApi.length) {
            throw getError(RESULT_ERROR, `API 返回的有效结果数 (${rawResultArray.length}) 与发送的有效段落数 (${textsForApi.length}) 不匹配。`);
        }

        // 7. 构造最终结果数组 (Final Result Array)
        
        // 1. 提取 API 返回的扁平化翻译文本 (string[])
        const flatApiTranslations = rawResultArray.map(item => (item && item.translation) || '');
        
        // 2. 将扁平化的翻译结果重构为原始的完整长度，并填充被跳过的项
        const fullFlatTranslations: string[] = Array(flattenedParagraphs.length).fill('');
        let apiIndex = 0;

        for (let i = 0; i < flattenedParagraphs.length; i++) {
            const originalIndex = i;
            
            if (validContentIndices.includes(originalIndex)) {
                // 有效内容，填充 API 翻译结果
                fullFlatTranslations[originalIndex] = flatApiTranslations[apiIndex];
                apiIndex++;
            } else {
                // ⭐️ 修正点：无效内容（如 ":"），填充其原始内容，以确保它不会消失 ⭐️
                fullFlatTranslations[originalIndex] = flattenedParagraphs[originalIndex] || ''; 
            }
        }

        // 3. 将完整长度的翻译结果重构为官方要求的嵌套结构
        let flatIndex = 0;
        const finalResult: FinalResultItem[] = paragraphsArray.map((row) => {
            const translationsForRow: string[] = [];
            
            for (let i = 0; i < row.length; i++) {
                if (flatIndex < fullFlatTranslations.length) {
                    translationsForRow.push(fullFlatTranslations[flatIndex]); 
                    flatIndex++;
                } else {
                    translationsForRow.push(""); 
                }
            }
            
            // 必须返回 { translations: string[] } 对象，且对象数组长度必须与 paragraphsArray 相同 
            return {
                translations: translationsForRow 
            } as FinalResultItem;
        });

        // 8. 校验和返回
        checkResultFromCustomWebpageTranslatSource({ result: finalResult }); 
        
        // 9. 返回最终的嵌套结果数组
        return finalResult;
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
