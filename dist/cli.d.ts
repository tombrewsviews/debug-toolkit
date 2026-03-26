/**
 * Terminal UI utilities — colors, symbols, formatting, interactive selector.
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
    bgCyan: string;
    inverse: string;
    hideCursor: string;
    showCursor: string;
    clearLine: string;
    moveUp: (n: number) => string;
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
    pointer: string;
};
export declare function banner(): void;
export declare function info(msg: string): void;
export declare function success(msg: string): void;
export declare function warn(msg: string): void;
export declare function error(msg: string): void;
export declare function dim(msg: string): void;
export declare function section(title: string): void;
export declare function kv(key: string, value: string): void;
export interface Spinner {
    update(msg: string): void;
    stop(finalMsg?: string): void;
}
export declare function spinner(msg: string): Spinner;
export declare function ready(toolCount: number): void;
export interface SelectOption {
    label: string;
    desc: string;
    detail: string;
}
export declare function select(prompt: string, options: SelectOption[]): Promise<number>;
export declare function printHelp(): void;
export { c };
