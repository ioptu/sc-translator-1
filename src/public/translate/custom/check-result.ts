// 文件路径: ./src/public/translate/custom/check-result.ts

// 警告：以下代码是为了测试目的而禁用校验。
// 在生产环境中，强烈建议恢复和修复校验。

// 保持 isAllStringInArray，因为 checkResultFromCustomSource 内部引用了它（尽管现在被注释）
export const isAllStringInArray = (array: any[]) => {
    for (let i = 0; i < array.length; i++) {
        if (typeof array[i] !== 'string') { return false; }
    }
    return true;
};

/**
 * 【临时禁用】校验函数，以确认错误源。
 * 恢复校验时，请将函数体替换为原来的内容。
 */
export const checkResultFromCustomSource = (result: any) => {
    // 原始校验逻辑已被注释：
    
    /*
    // required key "result", "from", "to"
    if (!('from' in result) || !('to' in result) || !('result' in result)) {
        const errorMessage = `Error: `
            + `${!('result' in result) ? '"result"' : ''} `
            + `${!('from' in result) ? '"from"' : ''} `
            + `${!('to' in result) ? '"to"' : ''} is/are required in response data.`;

        throw new Error(errorMessage);
    }
    // ... (其他校验逻辑) ...
    */
    
    // 返回而不执行任何操作，即让校验失效
    return;
};
