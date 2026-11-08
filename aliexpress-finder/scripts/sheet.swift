// Contact sheet: several images on one PNG, 4 per row, each tile numbered.
//
//   sheet <out.png> <cell px> <label:path> [label:path ...]
//
// Built and run by `labels.sh sheet <dir>`, which compiles this file once into
// ~/.cache/aliexpress-finder. WHY (measured 2026-11-08, the Dell charger
// session): "read every image" meant 434 images over 18 listings, one Read
// call each. ffmpeg on this Mac could not start (a missing libjxl library),
// PIL is not installed, and sips cannot place images side by side. AppKit can,
// and it ships with macOS. 12 images per sheet made it 27 Read calls for 273
// images. The red number on a tile is its img<N>.png, for the follow-up crop.
import AppKit

let args = CommandLine.arguments
guard args.count >= 4, let cellArg = Double(args[2]), cellArg >= 16 else {
  FileHandle.standardError.write("usage: sheet <out.png> <cell px> <label:path> [label:path ...]\n".data(using: .utf8)!)
  exit(2)
}
let out = args[1]
let cell = CGFloat(cellArg)
let items = args.dropFirst(3).map { s -> (String, String) in
  guard let i = s.firstIndex(of: ":") else { return ("?", s) }
  return (String(s[..<i]), String(s[s.index(after: i)...]))
}
let cols = 4
let rows = (items.count + cols - 1) / cols
let width = Int(cell) * cols
let height = Int(cell) * rows
guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
                                 samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                 bytesPerRow: 0, bitsPerPixel: 0) else { exit(1) }
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: width, height: height).fill()
var missing = 0
for (i, item) in items.enumerated() {
  // AppKit counts y from the bottom: row 0 is the top row.
  let x = CGFloat(i % cols) * cell
  let y = CGFloat(height) - CGFloat(i / cols + 1) * cell
  if let img = NSImage(contentsOfFile: item.1), img.size.width > 0, img.size.height > 0 {
    let k = min(cell / img.size.width, cell / img.size.height)
    let w = img.size.width * k, h = img.size.height * k
    img.draw(in: NSRect(x: x + (cell - w) / 2, y: y + (cell - h) / 2, width: w, height: h))
  } else {
    missing += 1
  }
  let size = max(12, cell * 0.068)
  let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.boldSystemFont(ofSize: size), .foregroundColor: NSColor.red,
                                              .backgroundColor: NSColor.white]
  (item.0 as NSString).draw(at: NSPoint(x: x + 6, y: y + cell - size * 1.25), withAttributes: attrs)
  NSColor.gray.setStroke()
  NSBezierPath(rect: NSRect(x: x, y: y, width: cell, height: cell)).stroke()
}
NSGraphicsContext.restoreGraphicsState()
guard let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
do { try png.write(to: URL(fileURLWithPath: out)) } catch { exit(1) }
print(out + " " + String(items.count) + (missing > 0 ? " (" + String(missing) + " could not be read)" : ""))
