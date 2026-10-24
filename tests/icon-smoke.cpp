// Manual regression test using the same SVG renderer as the Qt launcher.
#include <QGuiApplication>
#include <QSvgRenderer>
#include <QImage>
#include <QPainter>
#include <iostream>

int main(int argc, char **argv) {
  QGuiApplication app(argc, argv);
  if (argc != 3) return 4;
  QSvgRenderer svg(QString::fromLocal8Bit(argv[1]));
  if (!svg.isValid()) return 2;
  QImage image(256, 256, QImage::Format_ARGB32_Premultiplied);
  image.fill(Qt::transparent);
  QPainter painter(&image);
  svg.render(&painter);
  painter.end();
  int white = 0;
  for (int y = 0; y < 256; y++) {
    for (int x = 0; x < 256; x++) {
      const auto c = image.pixelColor(x, y);
      if (c.alpha() > 127 && c.red() > 180 && c.green() > 180 && c.blue() > 180) white++;
    }
  }
  std::cout << "whitePixels=" << white << '\n';
  if (!image.save(QString::fromLocal8Bit(argv[2]))) return 3;
  // The broken nested SVG loads as valid, but draws only its dark background.
  return white > 2000 ? 0 : 5;
}
