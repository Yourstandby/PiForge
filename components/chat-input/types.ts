export interface AttachedImage {
  data: string;   // base64, no prefix
  mimeType: string;
  previewUrl: string; // object URL for display（缩略图）
  /**
   * 原始文件（未降采样）的 object URL。查看器 / 下载 / 复制优先用它：
   * 发给模型的那份为了省 token 降过采样，点开看大图必须还是原图。
   */
  originalUrl?: string;
  /** 发给模型的像素尺寸（大图会先缩到长边 1568，见 lib/image-attachment.ts）。 */
  width?: number;
  height?: number;
  /** 缩放后的字节数 / 原始字节数（UI 上直接显示省了多少）。 */
  bytes?: number;
  originalBytes?: number;
}

export interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (text: string) => void;
  addImages: (files: File[]) => void;
}
