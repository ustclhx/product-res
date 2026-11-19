# 生成测试夹具 hangul-test.ttf：几个谚文字符共用一个方块字形，不含任何真实字体的轮廓，约 1 KB。
# 模板不附带真实韩文字体（项目自带字体与许可证），测试只需验证按需加载与 satori 能解析该字体。
# 用法：python3 -m pip install fonttools && python3 make-hangul-test-font.py
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

CHARS = '한국어보고서'


def box(inset):
    pen = TTGlyphPen(None)
    pen.moveTo((inset, 0))
    pen.lineTo((inset, 700))
    pen.lineTo((1000 - inset, 700))
    pen.lineTo((1000 - inset, 0))
    pen.closePath()
    return pen.glyph()


builder = FontBuilder(1000, isTTF=True)
builder.setupGlyphOrder(['.notdef', 'box'])
builder.setupCharacterMap({ord(char): 'box' for char in CHARS})
builder.setupGlyf({'.notdef': box(400), 'box': box(80)})
builder.setupHorizontalMetrics({'.notdef': (1000, 400), 'box': (1000, 80)})
builder.setupHorizontalHeader(ascent=880, descent=-120)
builder.setupNameTable({'familyName': 'Hangul Test', 'styleName': 'Regular'})
builder.setupOS2(sTypoAscender=880, sTypoDescender=-120, usWinAscent=880, usWinDescent=120)
builder.setupPost()
builder.save(str(Path(__file__).with_name('hangul-test.ttf')))
