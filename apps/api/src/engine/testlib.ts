import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Language } from "@forge/core";

/**
 * Polygon packages are written against testlib.h. The evaluator compiles one file and feeds
 * programs through stdin, so Forge inlines the header and adds a small `main` that adapts the
 * evaluator's conventions to what testlib expects:
 *
 * - generator: the arguments on the first line of stdin become argv;
 * - validator: nothing to adapt, testlib validators read stdin and fail with a message;
 * - checker: the separator-delimited stream is split into input, output and answer files,
 *   and testlib's outcome becomes AC / WA / custom:partial:<points>. A checker that returns
 *   from main without calling quit is reported as a failed checker.
 *
 * testlib interactors are not supported: the evaluator hands the test to the interactor on the
 * same stream as the solution's output, which testlib cannot tell apart.
 */
export type ToolRole = "generator" | "validator" | "checker";

const INCLUDE = /^[ \t]*#[ \t]*include[ \t]*[<"]testlib\.h[>"].*$/m;

let header: string | undefined;
const testlib = () => (header ??= readFileSync(fileURLToPath(new URL("../../vendor/testlib.h", import.meta.url)), "utf8"));

export const usesTestlib = (source: string, language: Language) => language === "cpp" && INCLUDE.test(source);

/**
 * The author's `main` is left alone (renaming it would lose `main`'s implicit `return 0`).
 * Instead the testlib entry points are wrapped: they are where a program hands testlib its
 * argv, so that is where the evaluator's stdin conventions are translated.
 */
const ADAPTERS: Record<ToolRole, string> = {
    validator: "",
    generator: `
static std::vector<std::string> forge_words;
static std::vector<char*> forge_argv;
template <class... Rest> void forge_register_gen(int& argc, char**& argv, Rest... rest) {
    std::string line;
    std::getline(std::cin, line);
    forge_words.assign(1, "generator");
    std::istringstream stream(line);
    for (std::string word; stream >> word;) forge_words.push_back(word);
    for (size_t i = 0; i < forge_words.size(); i++) forge_argv.push_back(&forge_words[i][0]);
    forge_argv.push_back(0);
    argc = (int)forge_words.size();
    argv = forge_argv.data();
    registerGen(argc, argv, rest...);
}
#define registerGen(...) forge_register_gen(__VA_ARGS__)
`,
    checker: `
static void forge_verdict() {
    int code = 3;
    try {
        if (std::current_exception()) std::rethrow_exception(std::current_exception());
    } catch (exit_exception& stopped) {
        code = stopped.getExitCode();
    } catch (...) {
    }
    std::fflush(stdout);
    if (code == 0) std::printf("AC\\n");
    else if (code == 1 || code == 2 || code == 4 || code == 8) std::printf("WA\\n");
    else if (code == 7) std::printf("custom:partial:%.6f\\n", __testlib_points);
    else std::printf("FAIL\\n");
    std::fflush(stdout);
    std::_Exit(0);
}
static void forge_register_checker() {
    std::set_terminate(forge_verdict);
    std::string text((std::istreambuf_iterator<char>(std::cin)), std::istreambuf_iterator<char>());
    const size_t first = text.find('\\n');
    const std::string separator = first == std::string::npos ? text : text.substr(0, first + 1);
    static char names[3][20] = {"forge_input.txt", "forge_answer.txt", "forge_output.txt"};
    size_t position = separator.size();
    for (int part = 0; part < 3; part++) {
        const size_t next = text.find("\\n" + separator, position > 0 ? position - 1 : 0);
        std::ofstream file(names[part], std::ios::binary);
        if (next == std::string::npos) continue;
        if (next >= position) file << text.substr(position, next - position);
        position = next + 1 + separator.size();
    }
    static char program[] = "checker";
    static char* argv[] = {program, names[0], names[2], names[1], 0};
    registerTestlibCmd(4, argv);
}
#define registerTestlibCmd(...) forge_register_checker()
`,
};

/** Inlines testlib.h into a C++ tool that includes it; other programs are returned unchanged. */
export const withTestlib = (source: string, language: Language, role: ToolRole): string => {
    if (!usesTestlib(source, language)) return source;
    const match = INCLUDE.exec(source)!;
    const line = source.slice(0, match.index).split("\n").length;
    const before = [
        role === "checker" ? "#define TESTLIB_THROW_EXIT_EXCEPTION_INSTEAD_OF_EXIT" : "",
        testlib(),
        "#include <fstream>\n#include <sstream>\n#include <iterator>\n#include <cstdio>\n#include <cstdlib>\n#include <exception>",
        ADAPTERS[role],
        `#line ${line + 1}`,
    ]
        .filter(Boolean)
        .join("\n");
    // a second include of the header would not be found by the compiler; the first one covers it
    const rest = source.slice(match.index + match[0].length).replace(new RegExp(INCLUDE.source, "gm"), "");
    return `${source.slice(0, match.index)}${before}${rest}`;
};
