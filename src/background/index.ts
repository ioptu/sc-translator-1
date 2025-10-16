// 文件路径: src/background/index.ts (或您的 background service worker 文件)

// 监听来自扩展程序其他部分的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // 检查请求类型，确保它是我们自定义的 API 代理请求
    if (request.type === 'FETCH_CUSTOM_API_PROXY') {
        
        const { url, options } = request.payload;
        
        // 🚨 关键：在后台 Service Worker 中执行 fetch，绕过前端 CORS 限制
        fetch(url, options)
            .then(async response => {
                // 必须序列化响应数据，不能直接转发 Response 对象
                const status = response.status;
                const ok = response.ok;
                
                // 确保即使 JSON 解析失败（如 500 错误），也能返回信息
                let data = null;
                try {
                    data = await response.json();
                } catch (e) {
                    // 如果不是 JSON 响应，data 保持 null
                }

                // 将状态和解析后的数据发送回前端
                sendResponse({
                    status: status,
                    ok: ok,
                    data: data,
                    error: null
                });
            })
            .catch(error => {
                // 捕获网络错误
                console.error("Background Fetch Error:", error);
                sendResponse({
                    status: 0,
                    ok: false,
                    data: null,
                    error: error.message
                });
            });

        // 必须返回 true，指示 sendResponse 将在异步操作完成后调用
        return true; 
    }
});
