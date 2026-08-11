import { parseFragment } from 'parse5';
import type { SourceLocation } from '../model';

export interface ParsedTemplateAttribute {
  name: string;
  value: string;
  start: number;
  end: number;
}

export interface ParsedTemplateElement {
  name: string;
  start: number;
  end: number;
  attributes: ParsedTemplateAttribute[];
}

export function textLocation(fileName: string, text: string, start: number, end: number): SourceLocation {
  return {
    fileName,
    start,
    end,
    line: text.slice(0, start).split(/\r?\n/).length - 1
  };
}

export function parseAngularTemplateElements(template: string): ParsedTemplateElement[] {
  interface HtmlNode {
    tagName?: string;
    attrs?: Array<{ name: string; value: string }>;
    childNodes?: HtmlNode[];
    sourceCodeLocation?: {
      startOffset?: number;
      endOffset?: number;
      attrs?: Record<string, { startOffset: number; endOffset: number }>;
    };
  }

  const root = parseFragment(template, { sourceCodeLocationInfo: true }) as unknown as HtmlNode;
  const elements: ParsedTemplateElement[] = [];
  const visit = (node: HtmlNode): void => {
    if (node.tagName) {
      const attributes = (node.attrs ?? []).map((attribute) => {
        const attributeLocation = node.sourceCodeLocation?.attrs?.[attribute.name];
        const start = attributeLocation?.startOffset ?? node.sourceCodeLocation?.startOffset ?? 0;
        const end = attributeLocation?.endOffset ?? start;
        const originalName = template.slice(start, end).match(/^\s*([^\s=]+)/)?.[1] ?? attribute.name;
        return { name: originalName, value: attribute.value, start, end };
      });
      elements.push({
        name: node.tagName,
        start: node.sourceCodeLocation?.startOffset ?? 0,
        end: node.sourceCodeLocation?.endOffset ?? node.sourceCodeLocation?.startOffset ?? 0,
        attributes
      });
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(root);
  return elements;
}
