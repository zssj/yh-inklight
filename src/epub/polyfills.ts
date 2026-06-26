/**
 * ES2024 polyfills for older mobile WebViews.
 * foliate-js uses Object.groupBy and Map.groupBy which are not available
 * in older Android WebView or iOS WKWebView.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const ObjectWithGroupBy = Object as any;
const MapWithGroupBy = Map as any;

if (typeof ObjectWithGroupBy.groupBy === "undefined") {
  ObjectWithGroupBy.groupBy = function groupBy<T, K extends PropertyKey>(
    items: Iterable<T>,
    callbackFn: (element: T, index: number) => K,
  ): Partial<Record<K, T[]>> {
    const result: Partial<Record<K, T[]>> = {};
    let index = 0;
    for (const item of items) {
      const key = callbackFn(item, index++);
      if (key in result) {
        result[key]!.push(item);
      } else {
        result[key] = [item];
      }
    }
    return result;
  };
}

if (typeof MapWithGroupBy.groupBy === "undefined") {
  MapWithGroupBy.groupBy = function groupBy<T, K>(
    items: Iterable<T>,
    callbackFn: (element: T, index: number) => K,
  ): Map<K, T[]> {
    const map = new Map<K, T[]>();
    let index = 0;
    for (const item of items) {
      const key = callbackFn(item, index++);
      if (map.has(key)) {
        map.get(key)!.push(item);
      } else {
        map.set(key, [item]);
      }
    }
    return map;
  };
}
