import { useEffect, useRef } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  type LexicalEditor,
  type SerializedEditorState,
} from "lexical";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import type { Block } from "./types";

function Bind({ onFocus }: { onFocus: (editor: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    const root = editor.getRootElement();
    const focus = () => onFocus(editor);
    root?.addEventListener("focus", focus);
    return () => root?.removeEventListener("focus", focus);
  }, [editor, onFocus]);
  return null;
}
function External({ block }: { block: Block }) {
  const [editor] = useLexicalComposerContext();
  const prior = useRef(block);
  useEffect(() => {
    if (prior.current === block) return;
    const state = editor.getEditorState();
    const current = state.read(() => $getRoot().getTextContent());
    const formattingChanged = block.marks_json.lexical
      ? JSON.stringify(state.toJSON()) !==
        JSON.stringify(block.marks_json.lexical)
      : Boolean(prior.current.marks_json.lexical);
    if (current !== block.text || formattingChanged) {
      if (block.marks_json.lexical) {
        try {
          editor.setEditorState(
            editor.parseEditorState(
              block.marks_json.lexical as SerializedEditorState,
            ),
            { tag: "external-sync" },
          );
        } catch {
          editor.update(
            () => {
              $getRoot()
                .clear()
                .append(
                  $createParagraphNode().append($createTextNode(block.text)),
                );
            },
            { tag: "external-sync" },
          );
        }
      } else
        editor.update(
          () => {
            $getRoot()
              .clear()
              .append(
                $createParagraphNode().append($createTextNode(block.text)),
              );
          },
          { tag: "external-sync" },
        );
    }
    prior.current = block;
  }, [block, editor]);
  return null;
}
export function RichBlock({
  block,
  onChange,
  onFocus,
  onError,
}: {
  block: Block;
  onChange: (text: string, marks: Record<string, unknown>) => void;
  onFocus: (editor: LexicalEditor) => void;
  onError: (message: string) => void;
}) {
  const last = useRef(
    JSON.stringify({ text: block.text, lexical: block.marks_json.lexical }),
  );
  return (
    <LexicalComposer
      initialConfig={{
        namespace: "block-" + block.id,
        nodes: [HeadingNode, QuoteNode],
        theme: {
          text: { bold: "text-bold", italic: "text-italic", code: "text-code" },
        },
        onError: () =>
          onError(
            "The editor could not apply a change. Your last saved draft is retained.",
          ),
        editorState: block.marks_json.lexical
          ? JSON.stringify(block.marks_json.lexical)
          : () => {
              $getRoot().append(
                $createParagraphNode().append($createTextNode(block.text)),
              );
            },
      }}
    >
      <div data-direction={block.direction_override ?? "auto"}>
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              className="rich-block"
              dir={block.direction_override ?? "auto"}
              aria-label="Transcript passage"
              spellCheck={false}
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
      </div>
      <HistoryPlugin />
      <External block={block} />
      <Bind onFocus={onFocus} />
      <OnChangePlugin
        ignoreSelectionChange
        onChange={(state, _editor, tags) => {
          const text = state.read(() => $getRoot().getTextContent());
          const lexical = state.toJSON();
          const serial = JSON.stringify({ text, lexical });
          if (tags.has("external-sync")) {
            last.current = serial;
            return;
          }
          if (serial !== last.current) {
            last.current = serial;
            onChange(text, { ...block.marks_json, lexical });
          }
        }}
      />
    </LexicalComposer>
  );
}
