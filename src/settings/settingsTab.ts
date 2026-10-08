/**
 * [INPUT]: 依赖 Obsidian PluginSettingTab/Setting 与 storage/types 的设置模型
 * [OUTPUT]: 对外提供 AnnotationSettingsTab，负责默认颜色、便签栏、窄屏折叠、连接线、作者、备份、重命名迁移设置
 * [POS]: settings 模块的用户配置界面，被 main.ts 注册
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import { PluginSettingTab, Setting } from "obsidian";

import type OverlayAnnotationsPlugin from "../../main";
import { detectAvailableFonts, FIXED_FONT_OPTIONS, resolveFontFamily } from "../epub/EpubFontCatalog";
import {
  ANNOTATION_COLORS,
  AnnotationColor,
  COLOR_LABELS,
  EPUB_HIGHLIGHT_STYLES,
  EPUB_READING_THEMES,
  EpubFlowMode,
  EpubHighlightStyle,
  EpubReadingTheme,
  SidebarSide,
} from "../storage/types";

export class AnnotationSettingsTab extends PluginSettingTab {
  constructor(private readonly plugin: OverlayAnnotationsPlugin) {
    super(plugin.app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "墨光批注" });

    new Setting(containerEl)
      .setName("默认高亮颜色")
      .addDropdown((dropdown) => {
        for (const color of ANNOTATION_COLORS) {
          dropdown.addOption(color, COLOR_LABELS[color]);
        }
        dropdown.setValue(this.plugin.settings.defaultHighlightColor).onChange(async (value) => {
          this.plugin.settings.defaultHighlightColor = value as AnnotationColor;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("便签宽度")
      .addSlider((slider) => {
        slider
          .setLimits(220, 420, 10)
          .setValue(this.plugin.settings.stickyWidth)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.stickyWidth = value;
            await this.plugin.saveSettings();
            this.plugin.refreshAnnotations();
          });
      });

    new Setting(containerEl)
      .setName("便签显示位置")
      .setDesc("右侧为阅读布局首选；左侧为高级偏好。")
      .addDropdown((dropdown) => {
        dropdown.addOption("right", "右侧");
        dropdown.addOption("left", "左侧");
        dropdown.setValue(this.plugin.settings.stickySide).onChange(async (value) => {
          this.plugin.settings.stickySide = value as SidebarSide;
          await this.plugin.saveSettings();
          this.plugin.refreshAnnotations();
        });
      });

    new Setting(containerEl)
      .setName("窄屏折叠阈值")
      .setDesc("当编辑面板宽度低于此值时，便签以弹层形式显示。")
      .addSlider((slider) => {
        slider
          .setLimits(640, 1200, 20)
          .setValue(this.plugin.settings.stickyCollapseWidth)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.stickyCollapseWidth = value;
            await this.plugin.saveSettings();
            this.plugin.refreshAnnotations();
          });
      });

    new Setting(containerEl)
      .setName("显示连接线")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.showLeaderLines).onChange(async (value) => {
          this.plugin.settings.showLeaderLines = value;
          await this.plugin.saveSettings();
          this.plugin.refreshAnnotations();
        });
      });

    new Setting(containerEl)
      .setName("默认作者")
      .addText((text) => {
        text.setValue(this.plugin.settings.defaultAuthor).onChange(async (value) => {
          this.plugin.settings.defaultAuthor = value.trim() || "读者";
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("重命名时迁移批注")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.migrateOnRename).onChange(async (value) => {
          this.plugin.settings.migrateOnRename = value;
          await this.plugin.saveSettings();
        });
      });

    this.renderEpubSettings();
    this.renderMarkdownStatsSettings();
  }

  /** EPUB 阅读相关设置：字号 / 正文字体 / 主题 / 翻页 / 高亮样式 / 摘录目录 / 段落模式 / 脚注 / 回显 */
  private renderEpubSettings(): void {
    const { containerEl } = this;
    containerEl.createEl("h3", { text: "EPUB 阅读" });

    new Setting(containerEl)
      .setName("阅读字号")
      .setDesc("EPUB 正文基础字号（px）。改完立即生效。")
      .addSlider((slider) => {
        slider
          .setLimits(12, 28, 1)
          .setValue(this.plugin.settings.epubFontSize)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.epubFontSize = value;
            await this.plugin.saveSettings();
            this.plugin.refreshEpubReaderAppearance();
          });
      });

    let fontSampleEl: HTMLElement | null = null;
    const refreshFontPreview = (): void => {
      if (!fontSampleEl) {
        return;
      }
      fontSampleEl.style.fontFamily =
        resolveFontFamily(this.plugin.settings.epubFontFamily, this.plugin.settings.epubFontFamilyCustom) ||
        "inherit";
    };

    const fontSetting = new Setting(containerEl)
      .setName("正文字体")
      .setDesc(
        "控制 EPUB 正文段落使用的字体。下拉只列出本机已安装的常见字体；列表里没有的可在下方手填，手填优先。书自带的标题、引文、代码字体不受影响。改完立即生效。",
      )
      .addDropdown((dropdown) => {
        for (const option of FIXED_FONT_OPTIONS) {
          dropdown.addOption(option.value, option.label);
        }
        for (const font of detectAvailableFonts()) {
          dropdown.addOption(font.name, font.label);
        }
        dropdown.setValue(this.plugin.settings.epubFontFamily).onChange(async (value) => {
          this.plugin.settings.epubFontFamily = value;
          await this.plugin.saveSettings();
          refreshFontPreview();
          this.plugin.refreshEpubReaderAppearance();
        });
      })
      .addText((text) => {
        text.setPlaceholder("手填字体名（可选，覆盖上方下拉）");
        text.setValue(this.plugin.settings.epubFontFamilyCustom);
        text.onChange(async (value) => {
          this.plugin.settings.epubFontFamilyCustom = value;
          await this.plugin.saveSettings();
          refreshFontPreview();
          this.plugin.refreshEpubReaderAppearance();
        });
      });

    const previewEl = fontSetting.settingEl.createDiv();
    previewEl.style.cssText =
      "flex-basis:100%;margin-top:8px;padding:8px 10px;border:1px solid var(--background-modifier-border);border-radius:6px;background:var(--background-secondary);";
    const previewLabel = previewEl.createDiv({ text: "预览" });
    previewLabel.style.cssText = "font-size:11px;color:var(--text-muted);margin-bottom:4px;";
    fontSampleEl = previewEl.createDiv({
      text: "永和九年，岁在癸丑，暮春之初，会于会稽山阴之兰亭 AaBbCc 0123456789",
    });
    fontSampleEl.style.cssText =
      "font-size:15px;line-height:1.7;color:var(--text-normal);word-break:break-word;";
    refreshFontPreview();

    new Setting(containerEl)
      .setName("阅读行距")
      .setDesc("EPUB 正文行距（倍）。改完立即生效。")
      .addSlider((slider) => {
        slider
          .setLimits(1.0, 2.5, 0.05)
          .setValue(this.plugin.settings.epubLineHeight)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.epubLineHeight = value;
            await this.plugin.saveSettings();
            this.plugin.refreshEpubReaderAppearance();
          });
      });

    new Setting(containerEl)
      .setName("统一正文字号")
      .setDesc("忽略电子书自带的正文缩放倍数，所有书正文按「阅读字号」显示；仅对正文确实被书内 CSS 缩放的书生效，脚注/图注不受影响。改完立即生效。")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.epubUnifyBodyFontSize)
          .onChange(async (value) => {
            this.plugin.settings.epubUnifyBodyFontSize = value;
            await this.plugin.saveSettings();
            this.plugin.refreshEpubReaderAppearance(true);
          });
      });

    new Setting(containerEl)
      .setName("阅读主题")
      .setDesc("EPUB 阅读区背景与文字配色。")
      .addDropdown((dropdown) => {
        for (const theme of EPUB_READING_THEMES) {
          dropdown.addOption(theme.id, theme.label);
        }
        dropdown.setValue(this.plugin.settings.epubReadingTheme).onChange(async (value) => {
          this.plugin.settings.epubReadingTheme = value as EpubReadingTheme;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("翻页模式")
      .setDesc("翻页为分页布局；滚动为连续滚动阅读。")
      .addDropdown((dropdown) => {
        dropdown.addOption("paginated", "翻页");
        dropdown.addOption("scrolled", "滚动");
        dropdown.setValue(this.plugin.settings.epubDefaultFlow).onChange(async (value) => {
          this.plugin.settings.epubDefaultFlow = value as EpubFlowMode;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("手机端沉浸式导航栏")
      .setDesc("手机上阅读 EPUB 时，向下滚动自动隐藏 Obsidian 底部导航栏，向上滚动恢复。")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.epubHideMobileNavbar).onChange(async (value) => {
          this.plugin.settings.epubHideMobileNavbar = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("高亮样式")
      .setDesc("EPUB 文本标注的默认呈现样式。")
      .addDropdown((dropdown) => {
        for (const style of EPUB_HIGHLIGHT_STYLES) {
          dropdown.addOption(style.id, style.label);
        }
        dropdown.setValue(this.plugin.settings.epubHighlightStyle).onChange(async (value) => {
          this.plugin.settings.epubHighlightStyle = value as EpubHighlightStyle;
          await this.plugin.saveSettings();
        });
      });
  }

  /** Markdown 打开次数统计设置：开关 + 清空 */
  private renderMarkdownStatsSettings(): void {
    const { containerEl } = this;
    containerEl.createEl("h3", { text: "Markdown 统计" });

    new Setting(containerEl)
      .setName("统计 Markdown 打开次数")
      .setDesc("记录每个 Markdown 笔记被打开的次数，用于「笔记使用统计」视图。只记录启用后的打开行为。")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.mdOpenTracking).onChange(async (value) => {
          this.plugin.settings.mdOpenTracking = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("清空打开次数统计")
      .setDesc("将全部 Markdown 笔记的打开次数清零（不影响批注数据）。")
      .addButton((button) => {
        button.setButtonText("清空统计").setWarning().onClick(async () => {
          this.plugin.mdOpenStats = {};
          await this.plugin.saveMdOpenStats();
          this.plugin.refreshMarkdownStatsViews();
        });
      });
  }
}
