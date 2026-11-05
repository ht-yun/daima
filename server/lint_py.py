import ast
import json
import sys


def main():
    code = sys.stdin.read()
    issues = []

    def add(line, sev, title, detail, rule, dim="syntax"):
        issues.append({
            "line": max(1, int(line or 1)),
            "dimension": dim,
            "severity": sev,
            "title": title,
            "detail": detail,
            "ruleId": rule,
        })

    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        kind = type(exc).__name__
        text = (exc.text or "").strip()
        if kind in ("TabError", "IndentationError"):
            add(exc.lineno or 1, "high", "缩进错误：" + (exc.msg or ""), text, "PY-INDENT")
        else:
            add(exc.lineno or 1, "high", "语法错误：" + (exc.msg or "无法解析"), text, "PY-SYNTAX")
        print(json.dumps({"issues": issues, "engine": "python-ast"}))
        return

    tab_line = None
    space_line = None
    for i, line in enumerate(code.split("\n"), start=1):
        if not line.strip():
            continue
        if line.startswith("\t") and tab_line is None:
            tab_line = i
        if line.startswith(" ") and space_line is None:
            space_line = i
    if tab_line and space_line:
        add(min(tab_line, space_line), "mid", "缩进混用（Tab 与空格）", "同一文件里同时出现 Tab 与空格缩进", "PY-MIXEDINDENT")

    imported = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imported[alias.asname or alias.name.split(".")[0]] = node.lineno
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name == "*":
                    continue
                imported[alias.asname or alias.name] = node.lineno

    loaded = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            loaded.add(node.id)

    for name, line in imported.items():
        if name not in loaded:
            add(line, "low", "导入未使用：" + name, "import 之后没有被引用", "PY-UNUSEDIMPORT")

    funcs = [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
    for fn in funcs:
        stores = {}
        loads = set()
        for node in ast.walk(fn):
            if isinstance(node, ast.Name):
                if isinstance(node.ctx, ast.Store):
                    stores.setdefault(node.id, node.lineno)
                elif isinstance(node.ctx, ast.Load):
                    loads.add(node.id)
        for name, line in stores.items():
            if name.startswith("_"):
                continue
            if name not in loads:
                add(line, "low", "变量未使用：" + name, "赋值之后没有再读它", "PY-UNUSEDVAR")

        all_args = []
        for group in (fn.args.posonlyargs, fn.args.args, fn.args.kwonlyargs):
            all_args.extend(group)
        for arg in all_args:
            name = arg.arg
            if name in ("self", "cls") or name.startswith("_"):
                continue
            if name not in loads:
                add(getattr(arg, "lineno", fn.lineno), "low", "参数未使用：" + name, "形参声明后没有在函数体里使用", "PY-UNUSEDARG")

    print(json.dumps({"issues": issues, "engine": "python-ast"}))


main()
