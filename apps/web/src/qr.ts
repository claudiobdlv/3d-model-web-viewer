import QRCode from "qrcode";

export async function downloadPublicShareQr(url: string, slug: string): Promise<void> {
  const canvas = document.createElement("canvas");
  await QRCode.toCanvas(canvas, url, {
    errorCorrectionLevel: "H",
    width: 1200,
    margin: 4,
    color: { dark: "#000000", light: "#ffffff" }
  });

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not create QR JPEG.")), "image/jpeg", 0.95);
  });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = `modelbase-qr-${slug}.jpg`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}
