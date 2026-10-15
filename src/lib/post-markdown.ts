import type { PhrasingContent, Root } from "mdast";
import { SKIP, visit } from "unist-util-visit";

import { HASHTAG } from "./social-text";

const SOCIAL_TOKEN = new RegExp(String.raw`(@[A-Za-z0-9_]{1,15})|(${HASHTAG.source})`, "gu");

/** Link social tokens in prose, without changing code or nesting links. */
export function remarkSocialLinks() {
  return (tree: Root) => {
    visit(tree, (node, index, parent) => {
      if (node.type === "link" || node.type === "linkReference") return SKIP;
      if (node.type !== "text" || index === undefined || !parent) return;
      const parts: PhrasingContent[] = [];
      let last = 0;
      for (const match of node.value.matchAll(SOCIAL_TOKEN)) {
        const start = match.index;
        if (start > last) parts.push({ type: "text", value: node.value.slice(last, start) });
        const token = match[0];
        parts.push({
          type: "link",
          url: token.startsWith("@") ? `/${token.slice(1)}` : `/explore?q=${encodeURIComponent(token)}`,
          children: [{ type: "text", value: token }],
        });
        last = start + token.length;
      }
      if (!parts.length) return;
      if (last < node.value.length) parts.push({ type: "text", value: node.value.slice(last) });
      parent.children.splice(index, 1, ...parts);
      return index + parts.length;
    });
  };
}
