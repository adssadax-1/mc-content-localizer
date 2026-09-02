// 开发者工具面板编译期门控标志。
// 由 vite.config.ts 的 define 静态替换：DEVTOOLS=1 时为 true，生产构建为 false。
// 为 false 时所有引用 __DEVTOOLS__ 的分支被 tree-shake，前端包不含 devtool 代码。
declare const __DEVTOOLS__: boolean;
