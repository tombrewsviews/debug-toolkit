/**
 * Terminal UI utilities — colors, symbols, formatting.
 * Zero dependencies. Works in any terminal.
 */
declare const c: {
    reset: string;
    bold: string;
    dim: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    red: string;
    gray: string;
    white: string;
    bgGreen: string;
    bgBlue: string;
};
export declare const sym: {
    check: string;
    cross: string;
    arrow: string;
    dot: string;
    circle: string;
    bar: string;
    dash: string;
    bolt: string;
};
export declare function banner(): void;
export declare function info(msg: string): void;
export declare function success(msg: string): void;
export declare function warn(msg: string): void;
export declare function error(msg: string): void;
export declare function dim(msg: string): void;
export declare function section(title: string): void;
export declare function kv(key: string, value: string): void;
export declare function ready(toolCount: number): void;
export declare function printHelp(): void;
export { c };
