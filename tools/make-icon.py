
from PIL import Image, ImageDraw, ImageFilter

S = 512
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# 渐变底：靛蓝 -> 青
grad = Image.new("RGB", (S, S))
gd = ImageDraw.Draw(grad)
top = (124, 92, 255)
bottom = (34, 211, 238)
for y in range(S):
    t = y / (S - 1)
    gd.line([(0, y), (S, y)], fill=(
        int(top[0] + (bottom[0] - top[0]) * t),
        int(top[1] + (bottom[1] - top[1]) * t),
        int(top[2] + (bottom[2] - top[2]) * t),
    ))

mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=118, fill=255)
img.paste(grad, (0, 0), mask)

# 顶部高光
gloss = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(gloss).ellipse([-120, -260, S + 120, 220], fill=(255, 255, 255, 38))
img.alpha_composite(Image.composite(gloss, Image.new("RGBA", (S, S), (0, 0, 0, 0)), mask))

d = ImageDraw.Draw(img)

# 文档阴影
shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle([152, 122, 378, 402], radius=26, fill=(20, 20, 40, 90))
img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(14)))

# 文档主体
d.rounded_rectangle([150, 110, 380, 390], radius=26, fill=(255, 255, 255, 255))
# 折角
d.polygon([(318, 110), (380, 110), (380, 172)], fill=(219, 224, 255, 255))

# 两行代码条
d.rounded_rectangle([186, 196, 344, 214], radius=9, fill=(124, 92, 255, 230))
d.rounded_rectangle([186, 232, 300, 250], radius=9, fill=(124, 92, 255, 150))

# 向下箭头（把文件"放进去"）
d.rounded_rectangle([248, 272, 282, 348], radius=17, fill=(109, 106, 240, 255))
d.polygon([(214, 338), (316, 338), (265, 392)], fill=(109, 106, 240, 255))

img.save(r"D:\\Lenovo\\Desktop\\H黑客松开发项目\\preview\\app-icon.png")
img.resize((256, 256), Image.LANCZOS).save(
    r"D:\\Lenovo\\Desktop\\H黑客松开发项目\\app.ico",
    format="ICO",
    sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)],
)
print("ok")
