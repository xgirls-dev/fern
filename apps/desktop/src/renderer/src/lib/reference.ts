export async function readReference(file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw new Error("Choose a PNG, JPEG, or WebP image.");
  // The backend limits the encoded payload to 14 MB (about 10 MB decoded).
  if (file.size > 10 * 1024 * 1024)
    throw new Error("Choose a reference smaller than 10 MB.");
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () =>
      reject(new Error("Could not read that image. Try another file."));
    reader.readAsDataURL(file);
  });
  await validateReference(url);
  return url;
}
export async function validateReference(url: string): Promise<void> {
  if (url.length > 14 * 1024 * 1024)
    throw new Error("Choose a reference smaller than 10 MB.");
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } catch {
    throw new Error("Could not read that image. Try another file.");
  }
  if (image.naturalWidth * image.naturalHeight > 16_000_000)
    throw new Error("Choose a reference of 16 megapixels or less.");
}
