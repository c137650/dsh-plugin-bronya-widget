"""
把舰长提供的素材(即梦视频 / viberot 动图)做成挂件用的循环动图。

流程:
  ffmpeg 抽帧 -> 缩到中间分辨率(输出的 2 倍)
  -> 逐帧从四边洪水填充抠掉外部背景,只留最大连通块(顺手去掉水印和噪点)
  -> 整段取共识轮廓(时间多数票),补小洞,得到一张整段不动的形状
  -> 柔边直接来自这张形状(一次轻模糊),而不是逐帧重新判定
  -> 只在"这一帧实打实多了块前景"(手伸出去、筷子甩开)时补 alpha
  -> 预乘 alpha 缩放到输出尺寸,存 WebP 动图。

为什么不是"每帧各抠各的":逐帧硬阈值正好落在素材的软边和压缩噪点上,边界
每一帧都在挪几像素,播放时看起来就是背景里一圈东西一闪一闪。详见 README。
"""
import json
import os
import subprocess
import time

import numpy as np
from PIL import Image

FFMPEG = r'E:\tts\ffmpeg-2026-01-14-git-6c878f8b82-essentials_build\bin\ffmpeg.exe'
HERE = os.path.dirname(os.path.abspath(__file__))
# 脚本放在插件的 tools/ 下时,资源目录在上一级;单独放在别处时就地算
ROOT = os.path.dirname(HERE) if os.path.basename(HERE) == 'tools' else HERE
SRC = os.path.join(HERE, 'src')
OUT = os.path.join(ROOT, 'assets')
PREVIEW = os.path.join(HERE, 'preview')

# tol   :中间分辨率上的容差(三通道绝对差之和),决定背景往外扩到哪儿
# strong:认定"这一帧这里确实有东西"的门槛,比 tol 高得多,噪点进不来
# fill  :补洞半径(中间分辨率像素),白被子上的小洞靠它补回来
# blur  :柔边半径(中间分辨率像素),整段恒定,所以不会闪
# gap   :被人物包住、又几乎和背景同色的块(头发与背之间那条缝)的判定门槛;
#         0 = 不挖。被子那种"自己的白"够不到这个门槛,所以不会被挖穿
# gain  :逐帧亮度对齐(素材开头几帧偏暗,不对齐的话循环时会有"暗一下")
SOURCES = {
    'wake': {'file': r'E:\绘画训练\jimeng-2026-11-08-2100-基于@图片1的像素风Q版角色，保持像素块质感、人物造型、服装配色完全不变。人物坐....mp4',
             'fps': 8, 'delay': 125, 'tol': 34, 'strong': 150, 'fill': 2, 'blur': 1.0, 'gap': 9},
    # 敲键盘生气的动画:前 72 帧是普通敲键盘,后面才是生气,只取后面那段
    'angrytype': {'file': r'E:\绘画训练\jimeng-2026-11-09-5964-基于@图片1，保持像素块质感、人物造型、服装、坐姿、电脑显示器、桌子、键盘完全不....mp4',
                  'fps': 12, 'delay': 110, 'tol': 34, 'strong': 150, 'fill': 2, 'blur': 1.0, 'gap': 9, 'from': 72},
    # 上班打游戏:前 30 帧是普通敲键盘,后面才是拿手柄,只取后面那段
    'game': {'file': r'E:\绘画训练\jimeng-2026-11-09-9779-基于@图片1，保持像素块质感、人物造型、服装、坐姿、电脑显示器、桌子、键盘位置完....mp4',
             'fps': 12, 'delay': 95, 'tol': 34, 'strong': 150, 'fill': 2, 'blur': 1.0, 'gap': 9, 'from': 30},
    # 拿起耳机/话筒说话:
    #   62-103 帧 —— 耳机在耳边、另一只手一直举着、眼神也是常态,循环接缝一致;
    #   第 104 帧起她睁大眼,107 帧把手放下,循环回第 60 帧时手又举起来,
    #   就是那个"急速放下又抬起"。
    'voice': {'file': r'E:\绘画训练\jimeng-2026-11-10-3930-像素风Q版角色，保持角色外观完全一致：银白色长马尾、青蓝色叶状发髻、蓝白科技感连....mp4',
              'fps': 12, 'delay': 110, 'tol': 34, 'strong': 150, 'fill': 2, 'blur': 1.0, 'gap': 9, 'from': 62, 'to': 104},
    'eat': {'file': r'E:\绘画训练\jimeng-2026-11-08-3643-基于@图片1的像素风Q版角色，保持像素块质感、人物造型、服装配色完全不变。人物捧....mp4',
            'fps': 8, 'delay': 125, 'tol': 34, 'strong': 150, 'fill': 2, 'blur': 1.0, 'gap': 9},
    'angry': {'file': r'E:\绘画训练\angry.gif',
              'fps': 8, 'delay': 125, 'tol': 34, 'strong': 150, 'fill': 2, 'blur': 1.0, 'gap': 9},
    # 睡姿素材的被子本身就是白的,容差必须收紧,否则洪水填充会顺着白被子灌进去;
    # 被子内部的纯白又不能当"背景缝"挖掉,所以 gap 关掉
    'sleep': {'file': r'E:\绘画训练\viberot-gif-84469d3b.gif',
              'fps': 8, 'delay': 160, 'tol': 18, 'strong': 120, 'fill': 3, 'blur': 1.0, 'gap': 0},
    'wakeup': {'file': r'E:\绘画训练\viberot-gif-344fba32.gif',
               'fps': 8, 'delay': 160, 'tol': 20, 'strong': 120, 'fill': 2, 'blur': 1.0, 'gap': 0},
}

SIZE = int(os.environ.get('WIDGET_SIZE', '144'))
QUALITY = int(os.environ.get('WIDGET_Q', '82'))
MID = 2.0  # 中间分辨率 = SIZE * MID


def extract(video, fps, dest, start_frame=None, end_frame=None):
    """抽帧。start/end 给定时只取那一段(素材里前后两段是不同动作时用)。"""
    os.makedirs(dest, exist_ok=True)
    for name in os.listdir(dest):
        os.remove(os.path.join(dest, name))
    vf = 'fps=%d' % fps
    if start_frame is not None:
        vf = 'trim=start_frame=%d,%s' % (int(start_frame), vf)
    if end_frame is not None:
        vf = 'trim=end_frame=%d,%s' % (int(end_frame), vf)
    subprocess.run([FFMPEG, '-y', '-v', 'error', '-i', video,
                    '-vf', vf, '-vsync', '0', os.path.join(dest, 'f%03d.png')], check=True)
    return sorted(os.path.join(dest, n) for n in os.listdir(dest) if n.endswith('.png'))


def ring_bg(rgb, r=3):
    """用画面最外圈几行的中值当背景色 —— 跟着素材的整体忽明忽暗走。"""
    parts = [rgb[:r].reshape(-1, 3), rgb[-r:].reshape(-1, 3),
             rgb[:, :r].reshape(-1, 3), rgb[:, -r:].reshape(-1, 3)]
    return np.median(np.concatenate(parts, axis=0), axis=0)


def dist1(rgb, bg):
    return np.abs(rgb.astype(np.int16) - np.asarray(bg, np.int16)).sum(axis=2)


def flood_scanline(passable):
    """从画面四边出发的扫描线洪水填充,返回被填到的区域。"""
    h, w = passable.shape
    filled = np.zeros((h, w), bool)
    stack = []
    for y in (0, h - 1):
        d = np.diff(np.concatenate(([0], passable[y].view(np.int8), [0])))
        for st in np.where(d == 1)[0]:
            stack.append((y, int(st)))
    for x in (0, w - 1):
        d = np.diff(np.concatenate(([0], passable[:, x].view(np.int8), [0])))
        for st in np.where(d == 1)[0]:
            stack.append((int(st), x))
    while stack:
        y, x = stack.pop()
        if not passable[y, x] or filled[y, x]:
            continue
        left = x
        while left > 0 and passable[y, left - 1] and not filled[y, left - 1]:
            left -= 1
        right = x
        while right < w - 1 and passable[y, right + 1] and not filled[y, right + 1]:
            right += 1
        filled[y, left:right + 1] = True
        for ny in (y - 1, y + 1):
            if 0 <= ny < h:
                seg = passable[ny, left:right + 1] & ~filled[ny, left:right + 1]
                if seg.any():
                    d = np.diff(np.concatenate(([0], seg.view(np.int8), [0])))
                    for st in np.where(d == 1)[0]:
                        stack.append((ny, left + int(st)))
    return filled


def largest_component(mask):
    """只留最大的一块,水印、碎屑一起清掉。"""
    h, w = mask.shape
    labels = np.zeros((h, w), np.int32)
    best, best_size, cur = 0, 0, 0
    for sy in range(h):
        for sx in np.where(mask[sy] & (labels[sy] == 0))[0]:
            sx = int(sx)
            if labels[sy, sx]:
                continue
            cur += 1
            stack = [(sy, sx)]
            labels[sy, sx] = cur
            size = 0
            while stack:
                y, x = stack.pop()
                left = x
                while left > 0 and mask[y, left - 1] and not labels[y, left - 1]:
                    left -= 1
                right = x
                while right < w - 1 and mask[y, right + 1] and not labels[y, right + 1]:
                    right += 1
                labels[y, left:right + 1] = cur
                size += right - left + 1
                for ny in (y - 1, y + 1):
                    if 0 <= ny < h:
                        seg = mask[ny, left:right + 1] & (labels[ny, left:right + 1] == 0)
                        if seg.any():
                            d = np.diff(np.concatenate(([0], seg.view(np.int8), [0])))
                            for st in np.where(d == 1)[0]:
                                stack.append((ny, left + int(st)))
            if size > best_size:
                best, best_size = cur, size
    return labels == best if best else mask


def drop_specks(mask, min_size=16):
    """去掉面积小于 min_size 的碎块。"""
    h, w = mask.shape
    seen = np.zeros((h, w), bool)
    keep = np.zeros((h, w), bool)
    for sy in range(h):
        for sx in np.where(mask[sy])[0]:
            sx = int(sx)
            if seen[sy, sx]:
                continue
            stack = [(sy, sx)]
            seen[sy, sx] = True
            cells = []
            while stack:
                y, x = stack.pop()
                cells.append((y, x))
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
            if len(cells) >= min_size:
                for y, x in cells:
                    keep[y, x] = True
    return keep


def _shift(m, op):
    out = m.copy()
    out[1:, :] = op(out[1:, :], m[:-1, :])
    out[:-1, :] = op(out[:-1, :], m[1:, :])
    out[:, 1:] = op(out[:, 1:], m[:, :-1])
    out[:, :-1] = op(out[:, :-1], m[:, 1:])
    return out


def erode(m, r):
    for _ in range(r):
        m = _shift(m, np.logical_and)
    return m


def dilate(m, r):
    for _ in range(r):
        m = _shift(m, np.logical_or)
    return m


def blur_f(a, sigma):
    """float 上的分离高斯(ImageFilter 的 GaussianBlur 不支持 F 模式)。"""
    if sigma <= 0:
        return a
    r = max(1, int(round(sigma * 2.5)))
    x = np.arange(-r, r + 1, dtype=np.float32)
    k = np.exp(-(x ** 2) / (2 * sigma * sigma))
    k /= k.sum()
    out = a.astype(np.float32)
    for axis in (0, 1):
        pad = [(0, 0)] * 2
        pad[axis] = (r, r)
        p = np.pad(out, pad, mode='edge')
        acc = np.zeros_like(out)
        for i, kv in enumerate(k):
            sl = [slice(None)] * 2
            sl[axis] = slice(i, i + out.shape[axis])
            acc += kv * p[tuple(sl)]
        out = acc
    return out


def shrink(rgb, scale):
    h, w, _ = rgb.shape
    tw, th = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
    return np.array(Image.fromarray(rgb).resize((tw, th), Image.BOX))


def crop_box(frames, t=110, pad=6):
    """整段共用一个裁切框:取"明显不是背景"的像素的并集,避免逐帧跳。"""
    left, top, right, bottom = 10 ** 9, 10 ** 9, -1, -1
    for f in frames:
        ys, xs = np.where(dist1(f, ring_bg(f)) > t)
        if len(xs) == 0:
            continue
        left, right = min(left, int(xs.min())), max(right, int(xs.max()))
        top, bottom = min(top, int(ys.min())), max(bottom, int(ys.max()))
    h, w = frames[0].shape[:2]
    if right < 0:
        return (0, 0, w, h)
    return (max(0, left - pad), max(0, top - pad), min(w, right + pad + 1), min(h, bottom + pad + 1))


def label_components(mask):
    """四连通标记(扫描线),返回 labels,背景为 0。"""
    h, w = mask.shape
    lab = np.zeros((h, w), np.int32)
    cur = 0
    for sy in range(h):
        for sx in np.where(mask[sy] & (lab[sy] == 0))[0]:
            sx = int(sx)
            if lab[sy, sx]:
                continue
            cur += 1
            stack = [(sy, sx)]
            lab[sy, sx] = cur
            while stack:
                y, x = stack.pop()
                left, right = x, x
                while left > 0 and mask[y, left - 1] and not lab[y, left - 1]:
                    left -= 1
                while right < w - 1 and mask[y, right + 1] and not lab[y, right + 1]:
                    right += 1
                lab[y, left:right + 1] = cur
                for ny in (y - 1, y + 1):
                    if 0 <= ny < h:
                        seg = mask[ny, left:right + 1] & (lab[ny, left:right + 1] == 0)
                        if seg.any():
                            d = np.diff(np.concatenate(([0], seg.view(np.int8), [0])))
                            for st in np.where(d == 1)[0]:
                                stack.append((ny, left + int(st)))
    return lab


def clear_enclosed_gaps(mask, med, loose=25, max_mid=9.0, min_area=40):
    """
    抠掉"被人物包住、颜色又和背景几乎一模一样"的块 —— 头发和背之间那条缝就是。
    判据是整块的背景距离中值要非常小(默认 <=9):皮肤高光、被子的白都够不到这个
    门槛,所以不会被挖穿。只按整段的中值判一次,所以也不会闪。
    """
    if max_mid <= 0:
        return mask, 0
    cand = mask & (med < loose)
    if not cand.any():
        return mask, 0
    lab = label_components(cand)
    out = mask.copy()
    cleared = 0
    for i in range(1, int(lab.max()) + 1):
        sel = lab == i
        if int(sel.sum()) < min_area:
            continue
        if float(np.median(med[sel])) > max_mid:
            continue
        out[sel] = False
        cleared += 1
    return out, cleared


def matte(files, spec):
    """返回 (中间分辨率的 RGB 帧, 每帧的 alpha[0..1])。"""
    big = [np.array(Image.open(p).convert('RGB')) for p in files]
    box = crop_box(big)
    scale = MID * SIZE / float(max(box[3] - box[1], box[2] - box[0]))
    small = [shrink(f[box[1]:box[3], box[0]:box[2]], scale) for f in big]
    dists = [dist1(s, ring_bg(s)) for s in small]
    med = np.median(np.stack(dists).astype(np.float32), axis=0)

    masks = [largest_component(~flood_scanline(d < spec['tol'])) for d in dists]
    union = largest_component(np.any(np.stack(masks), axis=0))
    allowed = dilate(union, 1)
    consensus = largest_component(np.stack(masks).mean(axis=0) >= 0.5)
    consensus = dilate(erode(consensus, spec.get('fill', 0)), spec.get('fill', 0)) & allowed
    # 补洞之后再挖"真背景的缝":顺序反了的话,补洞会把缝又填回去
    before_gap = consensus.copy()
    consensus, n_gap = clear_enclosed_gaps(consensus, med, loose=spec.get('gap_loose', 25),
                                           max_mid=spec.get('gap', 0.0))
    gap_mask = before_gap & ~consensus

    soft_allowed = np.clip(blur_f(allowed.astype(np.float32), 0.8), 0.0, 1.0)
    alphas = []
    for d in dists:
        extra = drop_specks((d > spec['strong']) & allowed & ~consensus)
        a = np.maximum(consensus, extra).astype(np.float32)
        # 柔边会顺着模糊把那条缝又糊回去一层白,所以挖掉的缝在模糊前后各压一次
        a[gap_mask] = 0.0
        a = np.clip(blur_f(a, spec.get('blur', 0.0)), 0.0, 1.0) * soft_allowed
        a[gap_mask] = 0.0
        alphas.append(np.clip(a, 0.0, 1.0))

    # 逐帧亮度对齐:素材开头几帧整体偏暗(浅色处差 4%,深色处几乎不变),循环播放时
    # 就是"某一帧突然暗一下"。用"每帧都不透明"的静态区域算平均亮度,把每帧的增益
    # 调到整段中值 —— 只做整体增益,不去拟合内容的明暗,所以不会把动画本身抹平。
    if spec.get('gain', True):
        core = erode((np.stack(alphas) > 0.9).all(axis=0), 1)
        if int(core.sum()) > 500:
            lum = np.array([float(s[core].astype(np.float32).mean()) for s in small], np.float32)
            ref = float(np.median(lum))
            if ref > 1:
                small = [np.clip(s.astype(np.float32) * (ref / max(l, 1.0)), 0, 255).astype(np.float32)
                         for s, l in zip(small, lum)]
    small = [s.astype(np.float32) for s in small]
    return small, alphas, n_gap


def to_final(rgb, alpha):
    """预乘 alpha 缩放:颜色只在 alpha 内部参与平均,不会留下白边。"""
    h, w = alpha.shape
    f = min((SIZE - 14) / float(h), SIZE / float(w))
    tw, th = max(1, int(round(w * f))), max(1, int(round(h * f)))
    prem = rgb.astype(np.float32) * alpha[:, :, None]

    def rs(arr):
        return np.stack([np.array(Image.fromarray(arr[:, :, c].astype(np.float32), 'F')
                                  .resize((tw, th), Image.LANCZOS), np.float32)
                         for c in range(arr.shape[2])], axis=2)

    prem_s = rs(prem)
    a_s = np.clip(rs(alpha[:, :, None])[:, :, 0], 0.0, 1.0)
    out = np.zeros_like(prem_s)
    nz = a_s > 1e-3
    out[nz] = prem_s[nz] / a_s[nz][:, None]

    canvas = np.zeros((SIZE, SIZE, 4), np.uint8)
    ox, oy = (SIZE - tw) // 2, (SIZE - th) // 2
    canvas[oy:oy + th, ox:ox + tw, :3] = np.clip(out, 0, 255).astype(np.uint8)
    canvas[oy:oy + th, ox:ox + tw, 3] = (a_s * 255.0 + 0.5).astype(np.uint8)
    return Image.fromarray(canvas, 'RGBA')


def build(state, spec):
    """处理一个状态并写出 assets/<state>.webp。"""
    frames = extract(spec['file'], spec['fps'], os.path.join(SRC, state), spec.get('from'), spec.get('to'))
    small, alphas, n_gap = matte(frames, spec)
    out_frames = [to_final(s, a) for s, a in zip(small, alphas)]
    dest = os.path.join(OUT, state + '.webp')
    os.makedirs(OUT, exist_ok=True)
    out_frames[0].save(dest, 'WEBP', save_all=True, append_images=out_frames[1:],
                       duration=spec['delay'], loop=0, quality=QUALITY, method=6, alpha_quality=100)
    print('%-8s %3d frames  crop %s  挖缝 %d 处  %5.1f KB' % (
        state, len(out_frames), 'x'.join(str(v) for v in small[0].shape[:2]), n_gap,
        os.path.getsize(dest) / 1024.0))
    return dest, out_frames


if __name__ == '__main__':
    import sys
    only = [a for a in sys.argv[1:] if not a.startswith('-')]
    targets = {k: v for k, v in SOURCES.items() if not only or k in only}
    manifest = {}
    manifest_path = os.path.join(OUT, 'manifest.json')
    if os.path.exists(manifest_path):
        try:
            with open(manifest_path, encoding='utf8') as f:
                manifest = json.load(f)
        except Exception:
            manifest = {}
    previews = []
    t0 = time.time()
    for state, spec in targets.items():
        dest, frames = build(state, spec)
        manifest[state] = {'file': state + '.webp', 'frames': len(frames), 'delay': spec['delay']}
        previews.append((state, frames))
    with open(manifest_path, 'w', encoding='utf8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    if previews:
        # 每个状态一列:深色底 / 洋红底各一帧,再并排几帧,方便一眼看出有没有残留
        cols = sum(min(6, len(fr)) for _, fr in previews)
        sheet = Image.new('RGB', (cols * SIZE, 2 * SIZE), (26, 28, 38))
        x = 0
        for _, fr in previews:
            pick = sorted(set(int(round(i * (len(fr) - 1) / 5.0)) for i in range(min(6, len(fr)))))
            for idx in pick:
                f = np.array(fr[idx]).astype(np.float32)
                a = f[:, :, 3:4] / 255.0
                for row, bg in enumerate(((26, 28, 38), (190, 0, 190))):
                    comp = f[:, :, :3] * a + np.array(bg, np.float32) * (1 - a)
                    sheet.paste(Image.fromarray(comp.astype(np.uint8), 'RGB'), (x * SIZE, row * SIZE))
                x += 1
        os.makedirs(PREVIEW, exist_ok=True)
        p = os.path.join(PREVIEW, 'states-' + time.strftime('%H%M%S') + '.png')
        sheet.save(p)
        print('preview ->', p)
    print('用时 %.1fs' % (time.time() - t0))
