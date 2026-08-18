/**
 * Paper Notes settings tab (Library UX round 2, 2026-08-15).
 *
 * Thin Obsidian GUI over the persisted `PaperNotesSettings` model in
 * plugin data.json. No new settings are invented here: every control edits
 * an existing field. The literature root is display-only (changing it would
 * break the vault layout), and the EasyScholar section is a read-only status
 * row — the SecretKey itself lives in the core CLI's private config
 * (ADR 0001), never in the plugin or data.json.
 */
import { App, Notice, PluginSettingTab, Setting, type TextComponent } from "obsidian";

import { CSL_STYLE_DIR, browserConnectorEnabledOf, metricsEnabledOf } from "./settings";
import type PaperNotesPlugin from "./main";

export class PaperNotesSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: PaperNotesPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.renderCore(containerEl);
    this.renderBrowserConnector(containerEl);
    this.renderExport(containerEl);
    this.renderMetrics(containerEl);
    void this.renderEasyScholarStatus(containerEl);
    void this.renderMineruKey(containerEl);
  }

  /** Browser Connector section (Task 6): enable toggle + read-only status. */
  private renderBrowserConnector(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Browser Connector").setHeading();

    new Setting(containerEl)
      .setName("Capture Bridge")
      .setDesc(
        "When enabled, Obsidian listens on http://127.0.0.1:27124/v1/capture so the Chromium Browser Connector can submit one paper page. Loopback only; requests without the connector version header cannot mutate.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(browserConnectorEnabledOf(this.plugin.settings))
          .onChange(async (value) => {
            await this.plugin.setBrowserConnectorEnabled(value);
            this.display();
          }),
      );

    const status = this.plugin.getBrowserConnectorStatus();
    const statusText: Record<string, string> = {
      running: "Running on 127.0.0.1:27124",
      disabled: "Disabled",
      port_conflict: "Port 27124 is in use by another process",
      error: "Error starting the bridge",
      stopped: "Stopped",
    };
    new Setting(containerEl)
      .setName("Status")
      .setDesc(statusText[status] ?? status)
      .setDisabled(true);
  }

  private renderCore(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Core").setHeading();

    new Setting(containerEl)
      .setName("paper-notes CLI path")
      .setDesc(
        "Path to the paper-notes core CLI executable. All managed writes route through this binary; a path change applies after reloading the plugin.",
      )
      .addText((text) =>
        text
          .setValue(this.plugin.settings.cliPath)
          .onChange(async (value) => {
            const next = value.trim();
            if (next.length > 0) {
              this.plugin.settings.cliPath = next;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Literature root")
      .setDesc(
        "Vault-relative literature directory (display-only; editing it would break the vault layout).",
      )
      .addText((text) =>
        text
          .setValue(this.plugin.settings.literatureRoot)
          .setDisabled(true),
      );
  }

  private renderExport(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Export").setHeading();

    new Setting(containerEl)
      .setName("Export directory")
      .setDesc("Fixed global output directory for Pandoc DOCX/PDF export (no fallback).")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.exportDirectory)
          .onChange(async (value) => {
            this.plugin.settings.exportDirectory = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Pandoc path")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.pandocPath)
          .onChange(async (value) => {
            const next = value.trim();
            if (next.length > 0) {
              this.plugin.settings.pandocPath = next;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("PDF engine")
      .setDesc("Engine passed to Pandoc for PDF export (e.g. xelatex).")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.pdfEngine)
          .onChange(async (value) => {
            const next = value.trim();
            if (next.length > 0) {
              this.plugin.settings.pdfEngine = next;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Reference DOCX")
      .setDesc("Reference DOCX used for export styling (empty when unset).")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.referenceDocx)
          .onChange(async (value) => {
            this.plugin.settings.referenceDocx = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    const cslStyles = this.listCslStyles();
    new Setting(containerEl)
      .setName("CSL style")
      .setDesc(
        "Globally selected citation style for export, picked from the vault's .paper-notes/csl/ directory.",
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("", "Default (none)");
        for (const name of cslStyles) {
          dropdown.addOption(name, name);
        }
        dropdown.setValue(this.plugin.settings.selectedCsl);
        dropdown.onChange(async (value) => {
          this.plugin.settings.selectedCsl = value;
          await this.plugin.saveSettings();
        });
      });
  }

  private renderMetrics(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Metrics").setHeading();

    new Setting(containerEl)
      .setName("Show journal metric badges")
      .setDesc(
        "CAS / JCR / IF / JCI badges in the library (UI-only volatile data; never written into notes).",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(metricsEnabledOf(this.plugin.settings))
          .onChange(async (value) => {
            this.plugin.settings.metricsEnabled = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Metric cache TTL (days)")
      .setDesc(
        "How long cached EasyScholar values stay fresh before the Refresh button re-queries.",
      )
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.metricTtlDays))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed > 0) {
              this.plugin.settings.metricTtlDays = parsed;
              await this.plugin.saveSettings();
            }
          }),
      );
  }

  /**
   * Read-only EasyScholar status row (ADR 0001): the SecretKey lives in the
   * core CLI's private config, never in the plugin. Presence is inferred
   * from cached metrics in plugin data.json — no key value is ever read or
   * shown, and no secret crosses this surface.
   */
  private renderEasyScholarStatus(containerEl: HTMLElement): void {
    const setting = new Setting(containerEl)
      .setName("EasyScholar key")
      .setDesc("Checking cached metrics…");
    let statusText: TextComponent | undefined;
    setting.addText((text) => {
      statusText = text;
      text.setValue("Checking…").setDisabled(true);
    });
    void this.easyscholarKeyConfigured().then((configured) => {
      setting.setDesc(
        configured
          ? "Configured: cached EasyScholar metrics are present. The SecretKey lives in the core CLI's private config (~/Library/Application Support/paper-notes/config.json, mode 0600); the plugin never stores or shows it. Reconfigure with: paper-notes config easyscholar import-zotero"
          : "No cached EasyScholar metrics found. If the library stays empty, configure the SecretKey in the core CLI's private config and refresh: paper-notes config easyscholar import-zotero",
      );
      statusText?.setValue(configured ? "Configured" : "Not detected");
    });
  }

  private async easyscholarKeyConfigured(): Promise<boolean> {
    try {
      const loaded = (await this.plugin.loadData()) as
        | Record<string, unknown>
        | undefined;
      const cache = loaded?.metricsCache;
      return (
        typeof cache === "object" &&
        cache !== null &&
        Object.keys(cache).length > 0
      );
    } catch {
      return false;
    }
  }

  /**
   * MinerU Key section (ADR 0002 / CONTEXT: MinerU Key). The key is entered
   * here but stored only in the core CLI's private config through stdin —
   * never in plugin data.json, never on argv, never shown back. A saved key
   * is never echoed, displayed, or copied; only the configured/not status is
   * surfaced.
   */
  private async renderMineruKey(containerEl: HTMLElement): Promise<void> {
    new Setting(containerEl).setName("MinerU").setHeading();

    const status = new Setting(containerEl)
      .setName("MinerU key")
      .setDesc("Checking…");
    let statusText: TextComponent | undefined;
    status.addText((text) => {
      statusText = text;
      text.setValue("Checking…").setDisabled(true);
    });

    const configured = await this.plugin.refreshMineruKeyStatus();
    status.setDesc(
      configured
        ? "Configured. The MinerU key lives in the core CLI's private config (~/Library/Application Support/paper-notes/config.json, mode 0600) and is never stored, echoed, or shown by this plugin."
        : "Not configured. Enter the MinerU API key below and save; it is sent to the core CLI on stdin and stored outside the vault (mode 0600).",
    );
    statusText?.setValue(configured ? "Configured" : "Not configured");

    const inputSetting = new Setting(containerEl)
      .setName("MinerU API key")
      .setDesc(
        "Only a new value can be entered here; a saved key is never shown back. Replace by saving a new value, remove with Delete.",
      );
    let input: TextComponent | undefined;
    inputSetting.addText((text) => {
      input = text;
      text.inputEl.type = "password";
      text.setPlaceholder("Enter MinerU API key");
    });

    inputSetting.addButton((button) =>
      button
        .setButtonText(configured ? "Replace key" : "Save key")
        .setCta()
        .onClick(async () => {
          const value = input?.getValue() ?? "";
          if (value.trim().length === 0) {
            new Notice("Enter a MinerU key first.");
            return;
          }
          const result = await this.plugin.setMineruKey(value);
          new Notice(result.message);
          if (result.ok) {
            input?.setValue("");
          }
          this.display();
        }),
    );

    if (configured) {
      inputSetting.addButton((button) =>
        button.setButtonText("Delete key").onClick(async () => {
          const result = await this.plugin.deleteMineruKey();
          new Notice(result.message);
          if (result.ok) {
            input?.setValue("");
          }
          this.display();
        }),
      );
    }
  }

  /** CSL styles present under the vault .paper-notes/csl/ directory. */
  private listCslStyles(): string[] {
    return this.app.vault
      .getFiles()
      .filter(
        (file) =>
          file.path.startsWith(`${CSL_STYLE_DIR}/`) &&
          file.extension === "csl",
      )
      .map((file) => file.name)
      .sort();
  }
}

