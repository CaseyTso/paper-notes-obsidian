/**
 * Pure index of Topic MOC notes.
 *
 * From a list of `{ path, text }` notes under `MOCs/`, returns display
 * items sorted by title. I/O stays out of this module — the Obsidian
 * adapter (in the view or `main.ts`) feeds cached reads.
 */

import { parseMocNote, type MocListItem } from "./moc-parse";

export type { MocListItem };

export function listTopicMocs(
  notes: ReadonlyArray<{ path: string; text: string }>,
): MocListItem[] {
  const items: MocListItem[] = [];
  for (const note of notes) {
    // v1 is flat: only paths whose parent segment is "MOCs"
    const parts = note.path.split("/");
    const parentSegment = parts.length >= 2 ? parts[parts.length - 2] : "";
    if (parentSegment !== "MOCs") {
      continue;
    }
    const parsed = parseMocNote(note.path, note.text);
    if (!parsed) {
      continue;
    }
    items.push({ path: note.path, title: parsed.title });
  }
  items.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
  return items;
}
