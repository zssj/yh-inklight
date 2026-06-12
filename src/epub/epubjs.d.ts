/**
 * epubjs 模块类型声明（暂未安装 npm 包，仅用于编译时类型引用）。
 * 安装 epubjs 后可移除此文件。
 */
declare module "epubjs" {
	function ePub(input: ArrayBuffer | string): any;
	export default ePub;
}
