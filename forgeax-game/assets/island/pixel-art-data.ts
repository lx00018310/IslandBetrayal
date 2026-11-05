// 《荒岛分赃》像素美术图集生成器
// 生成纯色、高辨识度的像素图集原始 RGBA 字节流，支持近距离正交 2.5D 呈现。

import { PLAYER_COLORS } from './simulation.ts';

export interface TextureData {
  width: number;
  height: number;
  rgba: Uint8Array;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const num = parseInt(clean, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function adjustColor(rgb: [number, number, number], factor: number): [number, number, number] {
  return [
    Math.min(255, Math.max(0, Math.round(rgb[0] * factor))),
    Math.min(255, Math.max(0, Math.round(rgb[1] * factor))),
    Math.min(255, Math.max(0, Math.round(rgb[2] * factor))),
  ];
}

class CanvasBitmap {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
  }

  setPixel(x: number, y: number, r: number, g: number, b: number, a = 255): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const idx = (y * this.width + x) * 4;
    this.data[idx] = r;
    this.data[idx + 1] = g;
    this.data[idx + 2] = b;
    this.data[idx + 3] = a;
  }

  fillRect(x: number, y: number, w: number, h: number, r: number, g: number, b: number, a = 255): void {
    for (let py = y; py < y + h; py++) {
      for (let px = x; px < x + w; px++) {
        this.setPixel(px, py, r, g, b, a);
      }
    }
  }

  fillCircle(cx: number, cy: number, radius: number, r: number, g: number, b: number, a = 255): void {
    const r2 = radius * radius;
    const minX = Math.floor(cx - radius);
    const maxX = Math.ceil(cx + radius);
    const minY = Math.floor(cy - radius);
    const maxY = Math.ceil(cy + radius);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r2) {
          this.setPixel(x, y, r, g, b, a);
        }
      }
    }
  }

  fillEllipse(cx: number, cy: number, rx: number, ry: number, r: number, g: number, b: number, a = 255): void {
    const rx2 = rx * rx;
    const ry2 = ry * ry;
    const minX = Math.floor(cx - rx);
    const maxX = Math.ceil(cx + rx);
    const minY = Math.floor(cy - ry);
    const maxY = Math.ceil(cy + ry);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if ((dx * dx) / rx2 + (dy * dy) / ry2 <= 1) {
          this.setPixel(x, y, r, g, b, a);
        }
      }
    }
  }
}

/** 生成柔和的暗色地面接触椭圆阴影 */
export function createShadowTexture(): TextureData {
  const w = 32;
  const h = 32;
  const bmp = new CanvasBitmap(w, h);
  const cx = 16;
  const cy = 16;
  const rx = 13;
  const ry = 8;
  const rx2 = rx * rx;
  const ry2 = ry * ry;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = (dx * dx) / rx2 + (dy * dy) / ry2;
      if (d <= 1) {
        // 中心深，边缘淡出
        const alpha = Math.round(180 * (1 - Math.sqrt(d)));
        bmp.setPixel(x, y, 22, 36, 30, alpha);
      }
    }
  }

  return { width: w, height: h, rgba: bmp.data };
}

/** 32x48 原创像素角色图集生成 */
export function createCharacterTexture(colorHex: string, style: number): TextureData {
  const w = 32;
  const h = 48;
  const bmp = new CanvasBitmap(w, h);
  const baseRgb = hexToRgb(colorHex);
  const darkRgb = adjustColor(baseRgb, 0.72);
  const lightRgb = adjustColor(baseRgb, 1.25);
  const skinRgb: [number, number, number] = [248, 206, 172];
  const skinShadow: [number, number, number] = [218, 170, 138];
  const hairDark: [number, number, number] = [46, 32, 24];

  // 1. 头发与头部轮廓 (Y: 6..14)
  bmp.fillEllipse(16, 12, 6, 6, hairDark[0], hairDark[1], hairDark[2]);

  // 头型与风格差异
  if (style === 0) {
    // 探险者宽檐帽子
    bmp.fillRect(10, 8, 12, 3, darkRgb[0], darkRgb[1], darkRgb[2]);
    bmp.fillRect(8, 10, 16, 2, baseRgb[0], baseRgb[1], baseRgb[2]);
  } else if (style === 1) {
    // 金色战额带 / 王冠
    bmp.fillRect(11, 11, 10, 2, 255, 218, 86);
    bmp.setPixel(16, 9, 255, 240, 140);
  } else if (style === 2) {
    // 银质战士头盔
    bmp.fillRect(10, 7, 12, 6, 180, 190, 205);
    bmp.fillRect(11, 11, 10, 2, 80, 88, 102);
  } else {
    // 披风斗篷兜帽
    bmp.fillEllipse(16, 11, 7, 6, darkRgb[0], darkRgb[1], darkRgb[2]);
  }

  // 2. 面部与眼睛 (Y: 13..21)
  bmp.fillRect(12, 13, 8, 8, skinRgb[0], skinRgb[1], skinRgb[2]);
  bmp.fillRect(12, 20, 8, 1, skinShadow[0], skinShadow[1], skinShadow[2]); // 下巴阴影
  // 眼睛
  bmp.fillRect(13, 16, 2, 2, 28, 28, 30);
  bmp.fillRect(17, 16, 2, 2, 28, 28, 30);
  // 腮红
  bmp.setPixel(12, 18, 235, 145, 145);
  bmp.setPixel(19, 18, 235, 145, 145);

  // 3. 躯干 / 战袍 (Y: 22..34)
  bmp.fillRect(14, 22, 4, 2, skinShadow[0], skinShadow[1], skinShadow[2]); // 脖颈
  bmp.fillRect(10, 24, 12, 9, baseRgb[0], baseRgb[1], baseRgb[2]); // 主衣身
  bmp.fillRect(10, 24, 2, 9, darkRgb[0], darkRgb[1], darkRgb[2]); // 左侧阴影
  bmp.fillRect(18, 24, 3, 9, lightRgb[0], lightRgb[1], lightRgb[2]); // 右侧高光

  // 腰带与腰带扣
  bmp.fillRect(10, 31, 12, 2, 44, 30, 20);
  bmp.fillRect(15, 31, 2, 2, 245, 205, 78);

  // 双臂与双手
  bmp.fillRect(8, 24, 2, 7, darkRgb[0], darkRgb[1], darkRgb[2]);
  bmp.fillRect(22, 24, 2, 7, baseRgb[0], baseRgb[1], baseRgb[2]);
  bmp.fillRect(8, 30, 2, 3, skinRgb[0], skinRgb[1], skinRgb[2]);
  bmp.fillRect(22, 30, 2, 3, skinRgb[0], skinRgb[1], skinRgb[2]);

  // 4. 裤腿与战靴 (Y: 34..46)
  // 裤子
  bmp.fillRect(11, 34, 4, 6, 42, 45, 48);
  bmp.fillRect(17, 34, 4, 6, 42, 45, 48);
  // 靴子
  bmp.fillRect(10, 40, 5, 5, 58, 38, 24);
  bmp.fillRect(17, 40, 5, 5, 58, 38, 24);
  // 鞋底深色边缘
  bmp.fillRect(10, 44, 5, 1, 24, 18, 14);
  bmp.fillRect(17, 44, 5, 1, 24, 18, 14);

  return { width: w, height: h, rgba: bmp.data };
}

/** 32x32 怪物像素图集生成（虚空紫怪） */
export function createMonsterTexture(): TextureData {
  const w = 32;
  const h = 32;
  const bmp = new CanvasBitmap(w, h);

  // 身体椭圆 (Y: 8..26)
  bmp.fillEllipse(16, 17, 9, 8, 92, 52, 134);
  bmp.fillEllipse(16, 17, 7, 6, 120, 72, 168);

  // 顶部尖角/耳朵
  bmp.fillRect(10, 6, 3, 4, 80, 42, 118);
  bmp.fillRect(19, 6, 3, 4, 80, 42, 118);

  // 恶魔红眼与眼白高光
  bmp.fillRect(11, 14, 3, 3, 255, 60, 60);
  bmp.fillRect(18, 14, 3, 3, 255, 60, 60);
  bmp.setPixel(12, 14, 255, 200, 200);
  bmp.setPixel(19, 14, 255, 200, 200);

  // 尖牙嘴部
  bmp.fillRect(14, 21, 4, 2, 40, 18, 62);
  bmp.setPixel(14, 21, 255, 255, 255);
  bmp.setPixel(17, 21, 255, 255, 255);

  // 触手/小足部
  bmp.fillRect(10, 25, 3, 4, 70, 36, 102);
  bmp.fillRect(19, 25, 3, 4, 70, 36, 102);

  return { width: w, height: h, rgba: bmp.data };
}

/** 32x32 共享宝箱图集生成 */
export function createChestTexture(): TextureData {
  const w = 32;
  const h = 32;
  const bmp = new CanvasBitmap(w, h);

  // 箱盖 (Y: 6..14)
  bmp.fillRect(6, 6, 20, 8, 168, 107, 48); // 木板
  bmp.fillRect(5, 7, 22, 2, 85, 52, 26); // 铁箍顶横条
  bmp.fillRect(5, 13, 22, 2, 55, 36, 18); // 铁箍底横条

  // 箱身 (Y: 14..25)
  bmp.fillRect(6, 14, 20, 11, 140, 85, 36);
  // 左右金铜包角
  bmp.fillRect(5, 14, 3, 11, 220, 168, 68);
  bmp.fillRect(24, 14, 3, 11, 220, 168, 68);
  // 竖向金属加固条
  bmp.fillRect(12, 8, 2, 17, 195, 142, 54);
  bmp.fillRect(18, 8, 2, 17, 195, 142, 54);

  // 锁孔与金锁 (Y: 13..18)
  bmp.fillRect(14, 13, 4, 5, 255, 220, 82);
  bmp.fillRect(15, 15, 2, 2, 42, 26, 14);

  return { width: w, height: h, rgba: bmp.data };
}

/** 16x16 金色掉落宝物像素图 */
export function createLootTexture(): TextureData {
  const w = 16;
  const h = 16;
  const bmp = new CanvasBitmap(w, h);

  // 钻石菱形或发光金块
  bmp.fillRect(4, 4, 8, 8, 245, 194, 55); // 基础金
  bmp.fillRect(4, 4, 8, 2, 255, 240, 135); // 顶高光
  bmp.fillRect(4, 10, 8, 2, 185, 132, 24); // 底暗面
  bmp.fillRect(4, 4, 2, 8, 220, 165, 40); // 侧暗面

  // 闪烁十字星光
  bmp.setPixel(6, 6, 255, 255, 255);
  bmp.setPixel(5, 6, 255, 248, 180);
  bmp.setPixel(7, 6, 255, 248, 180);
  bmp.setPixel(6, 5, 255, 248, 180);
  bmp.setPixel(6, 7, 255, 248, 180);

  return { width: w, height: h, rgba: bmp.data };
}

/** 32x32 灌木草丛场景道具 */
export function createBushTexture(): TextureData {
  const w = 32;
  const h = 32;
  const bmp = new CanvasBitmap(w, h);

  // 饱满圆润的绿色灌木簇
  bmp.fillCircle(12, 18, 8, 54, 98, 48);
  bmp.fillCircle(20, 18, 8, 68, 122, 58);
  bmp.fillCircle(16, 13, 7, 88, 150, 72); // 顶部亮簇
  bmp.fillCircle(15, 12, 4, 122, 186, 98); // 高光亮点

  // 底部阴影托底
  bmp.fillRect(10, 24, 12, 2, 36, 68, 34);

  return { width: w, height: h, rgba: bmp.data };
}

/** 32x32 岩石岩块道具 */
export function createRockTexture(): TextureData {
  const w = 32;
  const h = 32;
  const bmp = new CanvasBitmap(w, h);

  bmp.fillEllipse(16, 18, 11, 8, 92, 100, 108);
  bmp.fillEllipse(15, 16, 8, 5, 128, 136, 145);
  bmp.fillRect(12, 14, 6, 3, 172, 180, 190); // 顶面平整反光
  bmp.fillRect(8, 22, 16, 2, 60, 66, 72); // 贴地暗面

  return { width: w, height: h, rgba: bmp.data };
}

/** 32x32 水晶尖塔道具 */
export function createCrystalTexture(): TextureData {
  const w = 32;
  const h = 32;
  const bmp = new CanvasBitmap(w, h);

  // 尖顶晶体
  bmp.fillRect(14, 6, 4, 18, 90, 218, 240);
  bmp.fillRect(13, 10, 2, 14, 52, 160, 185);
  bmp.fillRect(17, 10, 2, 14, 140, 245, 255);
  bmp.setPixel(15, 4, 255, 255, 255);
  bmp.setPixel(16, 5, 255, 255, 255);

  return { width: w, height: h, rgba: bmp.data };
}
