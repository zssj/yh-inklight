/**
 * [INPUT]: 依赖 Obsidian PluginSettingTab/Setting 与 storage/types 的设置模型
 * [OUTPUT]: 对外提供 AnnotationSettingsTab，负责默认颜色、便签栏、窄屏折叠、连接线、作者、备份、重命名迁移设置
 * [POS]: settings 模块的用户配置界面，被 main.ts 注册
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import { Notice, Platform, PluginSettingTab, Setting } from "obsidian";

import type OverlayAnnotationsPlugin from "../../main";
import {
  AI_PROVIDER_PRESETS,
  isAiConfigured,
  resolveAiConfig,
  testAiConnection,
} from "../ai/EpubAiClient";
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
  EpubTapMode,
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
    this.renderAiSettings();
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
      .setName("翻页动画")
      .setDesc("翻页模式下切换页面时的 300ms 滑动过渡。连按方向键翻页会变慢，嫌钝可关闭。滚动模式不受影响；改设置后重开书生效。")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.epubPageAnimation).onChange(async (value) => {
          this.plugin.settings.epubPageAnimation = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("点击翻页")
      .setDesc("手机上点击书页如何翻页，仅翻页模式生效。分区：顶部 1/3 全宽往后翻（左手持机时上缘最好够），其下左 1/3 上一页、右 1/3 下一页，中间不翻；单击一律后翻无法用触摸往回翻；双击则只有双击会翻。点到选区、高亮、链接、图片，或长按选字时都不会触发。左右滑动手势由阅读器自带，与本档位无关，始终可用。改设置后重开书生效。")
      .addDropdown((dropdown) => {
        dropdown.addOption("single-zone", "单击分区（顶部全宽与右侧后翻，下方左侧前翻）");
        dropdown.addOption("single-next", "单击一律往后翻");
        dropdown.addOption("double", "双击往后翻");
        dropdown.addOption("off", "关闭");
        dropdown.setValue(this.plugin.settings.epubTapMode).onChange(async (value) => {
          this.plugin.settings.epubTapMode = value as EpubTapMode;
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

    if (Platform.isAndroidApp) {
      new Setting(containerEl)
        .setName("底部安全间距")
        .setDesc("EPUB 进度条与手机系统导航条之间的距离（px）。进度条被系统导航条挡住时调大，调到进度条完整露出为止。")
        .addSlider((slider) => {
          slider
            .setLimits(0, 64, 2)
            .setValue(this.plugin.settings.epubMobileBottomInset)
            .setDynamicTooltip()
            .onChange(async (value) => {
              this.plugin.settings.epubMobileBottomInset = value;
              await this.plugin.saveSettings();
              this.plugin.refreshEpubReaderAppearance();
            });
        });
    }

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

  /** AI 助手设置：服务商预设 / 接口地址 / Key / 模型 / 上限 / 附加提示词 / 连接测试 */
  private renderAiSettings(): void {
    const { containerEl } = this;
    containerEl.createEl("h3", { text: "AI 助手" });

    new Setting(containerEl)
      .setName("服务商")
      .setDesc("选中后自动填入接口地址与推荐模型名，你只需填 API Key。选「自定义」则三项都自己填。")
      .addDropdown((dropdown) => {
        for (const preset of AI_PROVIDER_PRESETS) {
          dropdown.addOption(preset.id, preset.label);
        }
        dropdown.setValue(this.plugin.settings.aiProvider).onChange(async (value) => {
          const preset = AI_PROVIDER_PRESETS.find((p) => p.id === value);
          this.plugin.settings.aiProvider = value;
          if (preset && preset.id !== "custom") {
            this.plugin.settings.aiBaseUrl = preset.baseUrl;
            this.plugin.settings.aiModel = preset.model;
          }
          await this.plugin.saveSettings();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("接口地址")
      .setDesc("OpenAI 兼容的 Base URL，通常以 /v1 结尾。")
      .addText((text) => {
        text.setValue(this.plugin.settings.aiBaseUrl).onChange(async (value) => {
          this.plugin.settings.aiBaseUrl = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("API Key")
      .setDesc("明文保存在本机插件 data.json，请勿把库目录外传。填完建议点下方「测试连接」。")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(this.plugin.settings.aiApiKey).onChange(async (value) => {
          this.plugin.settings.aiApiKey = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("模型名")
      .setDesc("例如 mimo-v2.6-flash、deepseek-chat。")
      .addText((text) => {
        text.setValue(this.plugin.settings.aiModel).onChange(async (value) => {
          this.plugin.settings.aiModel = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("最大 Token")
      .setDesc("单次回复的输出上限。默认 1024；「自定义」提问要 200-300 字，调小容易被截断。回复被截断时会在末尾提示。")
      .addSlider((slider) => {
        slider
          .setLimits(256, 4096, 256)
          .setValue(this.plugin.settings.aiMaxTokens)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.aiMaxTokens = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("附加系统提示词")
      .setDesc("可留空。填了会追加在内置提示词之后，用来调整风格，例如「回答要像给高中生讲课」。")
      .addTextArea((area) => {
        area.setValue(this.plugin.settings.aiSystemPrompt).onChange(async (value) => {
          this.plugin.settings.aiSystemPrompt = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("连接测试")
      .setDesc("用当前配置发一条极小请求，验证地址、Key 与模型是否可用。")
      .addButton((button) => {
        button.setButtonText("测试连接").setCta().onClick(async () => {
          const cfg = resolveAiConfig(this.plugin.settings);
          if (!isAiConfigured(cfg)) {
            new Notice("AI 助手：请先把接口地址、API Key、模型名都填上");
            return;
          }
          const originalLabel = button.buttonEl.textContent ?? "测试连接";
          button.setDisabled(true);
          button.setButtonText("测试中…");
          try {
            const reply = await testAiConnection(cfg);
            new Notice(`AI 助手连接成功：${reply.slice(0, 80)}`, 8000);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`AI 助手测试失败：${message}`, 12000);
          } finally {
            button.setDisabled(false);
            button.setButtonText(originalLabel);
          }
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
