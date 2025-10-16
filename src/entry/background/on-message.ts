// 文件路径: /src/entry/background/on-message.ts

import * as types from '../../constants/chromeSendMessageTypes';
import { translate, audio, detect } from '../../public/request';
import { createSeparateWindow } from './separate-window';
import { syncSettingsToOtherBrowsers } from './sync';
import scIndexedDB, { DB_STORE_COLLECTION } from '../../public/sc-indexed-db';
import {
    AudioResponse,
    ChromeRuntimeMessage,
    DetectResponse,
    GetAllCollectedTextResponse,
    GetCacheResponse,
    GetSelectorsResponse,
    IsCollectResponse,
    TranslateResponse
} from '../../public/send';
import { addCache, getCache } from './page-translation-cache';
import { getSpecifySelectors } from './page-translation-rule';
import scOptions from '../../public/sc-options';

type ProxyResponse = { 
    status: number, 
    ok: boolean, 
    data: any, 
    error: string | null 
};

type TypedSendResponse = (
    response: TranslateResponse | AudioResponse | DetectResponse | IsCollectResponse | GetCacheResponse | GetSelectorsResponse | GetAllCollectedTextResponse | ProxyResponse
) => void;

chrome.runtime.onMessage.addListener((message: ChromeRuntimeMessage, sender, sendResponse: TypedSendResponse) => {
    switch (message.type) {
        case types.SCTS_TRANSLATE: {
            scOptions.get(['useDotCn', 'preferredLanguage', 'secondPreferredLanguage'])
                .then(({ useDotCn, ...preferred }) => (translate({ ...message.payload, com: !useDotCn, ...preferred })))
                .then(sendResponse);

            return true;
        }
        case types.SCTS_AUDIO: {
            scOptions.get(['useDotCn'])
                .then(({ useDotCn }) => (audio({ ...message.payload, com: !useDotCn })))
                .then(sendResponse);

            return true;
        }
        case types.SCTS_DETECT: {
            scOptions.get(['useDotCn'])
                .then(({ useDotCn }) => (detect({ ...message.payload, com: !useDotCn })))
                .then(sendResponse);

            return true;
        }
        
        // 🚨 新增：自定义 API 代理请求处理
        case types.SCTS_CUSTOM_API_PROXY: {
            const { url, options } = message.payload;

            // 关键：在后台 Service Worker 中执行 fetch，绕过前端 CORS 限制
            fetch(url, options)
                .then(async response => {
                    const status = response.status;
                    const ok = response.ok;
                    
                    let data = null;
                    try {
                        // 尝试解析 JSON
                        data = await response.json();
                    } catch (e) {
                        // 如果解析失败，则忽略
                    }

                    // 将状态和解析后的数据发送回前端
                    sendResponse({
                        status: status,
                        ok: ok,
                        data: data,
                        error: null
                    } as ProxyResponse);
                })
                .catch(error => {
                    // 捕获网络错误
                    console.error("Background Proxy Fetch Error:", error);
                    sendResponse({
                        status: 0,
                        ok: false,
                        data: null,
                        error: error.message
                    } as ProxyResponse);
                });

            // 必须返回 true，通知 Chrome 这是一个异步响应，解决 'port closed' 错误。
            return true;
        }

        case types.SCTS_SEND_TEXT_TO_SEPARATE_WINDOW: {
            const { text } = message.payload;

            text && createSeparateWindow(text);

            return false;
        }
        case types.SCTS_SYNC_SETTINGS_TO_OTHER_BROWSERS: {
            syncSettingsToOtherBrowsers();

            return false;
        }
        case types.SCTS_IS_COLLECTED: {
            let { text } = message.payload;

            text = text.trimStart().trimEnd();

            if (text) {
                scIndexedDB.get(DB_STORE_COLLECTION, text)
                    .then(value => sendResponse({ text: message.payload.text, isCollected: !!value }))
                    .catch(() => sendResponse({ code: '' }));
            }
            else {
                sendResponse({ code: 'EMPTY_TEXT' });
            }

            return true;
        }
        case types.SCTS_ADD_TO_COLLECTION: {
            let { text, translations } = message.payload;

            text = text.trimStart().trimEnd();

            text && scIndexedDB.get(DB_STORE_COLLECTION, text).then((value) => {
                if (value) {
                    const translationMap = new Map([...value.translations, ...translations].map((v) => ([v.source, v.translateRequest])));

                    const nextTranslations: typeof value.translations = [...translationMap.entries()].map(([k, v]) => ({ source: k, translateRequest: v }));

                    scIndexedDB.add(DB_STORE_COLLECTION, { ...value, date: Number(new Date()), translations: nextTranslations });
                }
                else {
                    scIndexedDB.add(DB_STORE_COLLECTION, { text, date: Number(new Date()), translations });
                }
            });

            return false;
        }
        case types.SCTS_REMOVE_FROM_COLLECTION: {
            let { text } = message.payload;

            text = text.trimStart().trimEnd();

            text && scIndexedDB.delete(DB_STORE_COLLECTION, text);

            return false;
        }
        case types.SCTS_GET_PAGE_TRANSLATION_CACHE: {
            const { keys, source, from, to } = message.payload;

            getCache(keys, source, from, to).then(data => sendResponse(data));

            return true;
        }
        case types.SCTS_SET_PAGE_TRANSLATION_CACHE: {
            const { cache, source, from, to } = message.payload;

            addCache(cache, source, from, to);
            
            return false;
        }
        case types.SCTS_GET_SPECIFY_SELECTORS: {
            const { hostAndPathname } = message.payload;

            getSpecifySelectors(hostAndPathname).then(data => sendResponse(data));

            return true;
        }
        case types.SCTS_GET_ALL_COLLECTED_TEXT: {

            scIndexedDB.getAllKeys('collection').then(data => sendResponse(data as string[]));

            return true;
        }
        default: return;
    }
});
