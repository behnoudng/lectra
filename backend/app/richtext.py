"""Render the persisted editor tree without changing logical Unicode order."""

import re
from .errors import AppError

SUPPORTED = {"root", "paragraph", "heading", "quote", "text", "linebreak", "tab"}


def logical_text(node):
    if not isinstance(node, dict) or node.get("type") not in SUPPORTED:
        raise AppError("validation", "Unsupported transcript formatting node.")
    kind = node["type"]
    if kind == "text":
        if not isinstance(node.get("text"), str):
            raise AppError("validation", "Invalid formatted text.")
        return node["text"]
    if kind == "linebreak":
        return "\n"
    if kind == "tab":
        return "\t"
    children = node.get("children", [])
    if not isinstance(children, list):
        raise AppError("validation", "Invalid formatted paragraph.")
    return ("\n\n" if kind == "root" else "").join(
        logical_text(child) for child in children
    )


def markdown(node):
    kind = node["type"]
    if kind == "text":
        text = node["text"]
        flags = node.get("format", 0)
        if not isinstance(flags, int):
            flags = 0
        if flags & 16:
            ticks = "`" * (
                max((len(run) for run in re.findall(r"`+", text)), default=0) + 1
            )
            return ticks + text + ticks
        if flags & 1:
            text = "**" + text + "**"
        if flags & 2:
            text = "*" + text + "*"
        return text
    if kind == "linebreak":
        return "\n"
    if kind == "tab":
        return "\t"
    rendered = ("\n\n" if kind == "root" else "").join(
        markdown(c) for c in node.get("children", [])
    )
    if kind == "heading":
        tag = node.get("tag", "h2")
        if tag not in ("h1", "h2", "h3", "h4", "h5", "h6"):
            tag = "h2"
        return "#" * int(tag[1]) + " " + rendered
    if kind == "quote":
        return "> " + rendered.replace("\n", "\n> ")
    return rendered
