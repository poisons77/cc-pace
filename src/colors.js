// ANSI helpers. Built from a char code so no raw control bytes ever live in the source.

const ESC = String.fromCharCode(27);

const CODES = {
    reset: 0,
    dim: 90,
    red: 31,
    green: 32,
    yellow: 33,
    cyan: 36,
};

/**
 * @param {boolean} enabled When false every helper returns the bare text.
 */
export function palette(enabled) {
    const wrap = (name) => (text) =>
        enabled ? `${ESC}[${CODES[name]}m${text}${ESC}[${CODES.reset}m` : String(text);

    return {
        enabled,
        dim: wrap("dim"),
        red: wrap("red"),
        green: wrap("green"),
        yellow: wrap("yellow"),
        cyan: wrap("cyan"),
    };
}

/**
 * Honours the NO_COLOR convention (https://no-color.org) and an explicit --no-color flag.
 */
export function colorEnabled({ noColorFlag = false, env = process.env } = {}) {
    if (noColorFlag) return false;
    if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
    if (env.CC_PACE_COLOR === "0") return false;
    return true;
}
