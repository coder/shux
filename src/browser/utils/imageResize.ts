import { MAX_IMAGE_DIMENSION } from "@/common/constants/imageAttachments";
import {
  computeResizedDimensions,
  getResizedRasterOutputMediaType,
} from "@/common/utils/attachments/rasterImageResize";

export interface ResizeResult {
  dataUrl: string;
  mediaType: string;
  resized: boolean;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load image for resizing"));
    image.src = dataUrl;
  });
}

export { computeResizedDimensions };

export async function resizeImageIfNeeded(
  dataUrl: string,
  mediaType: string,
  maxDimension: number = MAX_IMAGE_DIMENSION
): Promise<ResizeResult> {
  const image = await loadImage(dataUrl);
  const originalWidth = image.naturalWidth;
  const originalHeight = image.naturalHeight;

  if (originalWidth <= 0 || originalHeight <= 0) {
    throw new Error("Failed to read image dimensions");
  }

  const resizedDimensions = computeResizedDimensions(originalWidth, originalHeight, maxDimension);
  if (!resizedDimensions) {
    return {
      dataUrl,
      mediaType,
      resized: false,
      originalWidth,
      originalHeight,
      width: originalWidth,
      height: originalHeight,
    };
  }

  const canvas = document.createElement("canvas");
  canvas.width = resizedDimensions.width;
  canvas.height = resizedDimensions.height;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Failed to create canvas context for image resize");
  }

  context.drawImage(image, 0, 0, resizedDimensions.width, resizedDimensions.height);

  const outputMediaType = getResizedRasterOutputMediaType(mediaType);
  const resizedDataUrl =
    outputMediaType === "image/jpeg"
      ? canvas.toDataURL(outputMediaType, 0.9)
      : canvas.toDataURL(outputMediaType);

  return {
    dataUrl: resizedDataUrl,
    mediaType: outputMediaType,
    resized: true,
    originalWidth,
    originalHeight,
    width: resizedDimensions.width,
    height: resizedDimensions.height,
  };
}
