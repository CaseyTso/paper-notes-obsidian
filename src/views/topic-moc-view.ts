/** Compatibility view for saved workspaces; the directory lives in the Library. */
import { ItemView, type WorkspaceLeaf } from "obsidian";

export const VIEW_TYPE_TOPIC_MOC = "paper-notes-topic-moc";

export class PaperNotesMocView extends ItemView {
  private isOpen = false;

  constructor(leaf: WorkspaceLeaf, private readonly openDirectory: () => Promise<void>) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE_TOPIC_MOC; }
  getDisplayText(): string { return "Topic MOC"; }
  getIcon(): string { return "list"; }

  async onOpen(): Promise<void> {
    this.isOpen = true;
    await this.openDirectory();
    if (this.isOpen) this.leaf.detach();
  }

  async onClose(): Promise<void> {
    this.isOpen = false;
  }
}
