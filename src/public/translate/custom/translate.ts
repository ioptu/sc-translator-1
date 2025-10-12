import { SOURCE_ERROR } from '../../../constants/errorCodes';
import { TranslateResult } from '../../../types';
import { TranslateParams } from '../translate-types';
import { fetchData, getError } from '../utils';
import { langCode } from '../google/lang-code'; // 假设这是一个包含语言代码映射的对象
import { LANGUAGE_NOT_SOPPORTED, RESULT_ERROR } from '../error-codes';
import { checkResultFromCustomSource } from './check-result'; // 保持导入
import scOptions from '../../sc-options';

// ----------------------------------------------------------------------
// 辅助类型定义 (为了代码完整性，实际应在其他文件)
// ----------------------------------------------------------------------

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
        
        // 解析参数字符串 (使用 '&' 分隔，'=' 赋值)
        paramsString.split('&').forEach(pair => {
            const [key, value] = pair.split('=');
            if (key) {
                let rawKey = decodeURIComponent(key);
                let rawValue = value || ''; 
                // 仅对键和值进行 URL 解码，保留值中的任何引号
                extractedParams[rawKey] = decodeURIComponent(rawValue);
            }
        });
    }

    // 映射自定义参数到目标位置/键名
    const authorizationToken = extractedParams['key'] || ''; 
    const translatorCodeValue = extractedParams['tc'] || '';
    const promptBuilderCodeValue = extractedParams['pbc'] || 0; 
    
    // 构造 Authorization Header 值 (自动添加 Bearer 前缀)
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
        'Authorization': authorizationHeaderValue, // 动态设置 Authorization
        // 添加示例中的其他固定 Header
        "accept": "*/*",
        "accept-language": navigator.language || "zh-CN",
        "x-browser-language": navigator.language || "zh-CN",
        "priority": "u=1, i",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "none",
        "x-client-version": "1.6.7",
    };

    // 4. 构造请求 Body (fetchJSON) 
    let fetchJSON = {
        targetLanguage: langCode[to], // 使用映射后的目标语言代码
        translatorCode: translatorCodeValue,
        promptBuilderCode: promptBuilderCodeValue,
        texts: [ // 适配 API 要求的文本结构
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
        let responseData: CustomApiResponse = await res.json(); 
        
        // 检查自定义 API 状态码
        if (responseData.code !== 'S000000' || !responseData.data) {
            // 如果 API 返回的 code 不是成功，或者 data 字段缺失
            throw getError(responseData.code || RESULT_ERROR, responseData.message || 'API返回非成功状态码');
        }

        // 提取实际数据
        let data = responseData.data;
        
        // 6. 自动切换目标语言 (二次请求逻辑)
        const sourceLangFromApi = data.sourceLanguage;
        const targetLangFromApi = data.targetLanguage;
        
        // 检查是否用户未指定语言 且 自动检测结果与目标语言相同
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

            // 处理二次请求的响应
            responseData = await newRes.json();
            
            if (responseData.code !== 'S000000' || !responseData.data) {
                 throw getError(responseData.code || RESULT_ERROR, responseData.message || 'API返回非成功状态码 (二次请求)');
            }
            data = responseData.data;
        }
        
        // 7. 构造最终结果，确保符合 TranslateResult 结构，以通过外部校验
        const translatedText = data.texts[0]?.translation; // 提取翻译结果

        // 校验：如果必需数据不存在，提前抛出错误，避免返回不完整对象
        if (!translatedText || !data.sourceLanguage) {
            throw getError(RESULT_ERROR, 'API返回的翻译结果或源语言为空，无法构造完整的翻译结果');
        }
        
        const result: TranslateResult = {
            // 必须有这三个字段
            result: [translatedText], // 翻译文本必须是字符串数组
            from: data.sourceLanguage, // 源语言必须是字符串
            to: to,                      // 目标语言必须是字符串
            
            // 原始文本
            text: text, 
            
            // 可选字段 (设置为 undefined 即可通过校验)
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
            throw getError(RESULT_ERROR); 
        }
    }
};

// ----------------------------------------------------------------------
// 【已删除】checkResultFromCustomSource 和 isAllStringInArray 的实现
// ----------------------------------------------------------------------
