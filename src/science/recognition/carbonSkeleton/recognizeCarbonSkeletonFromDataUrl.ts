/**
 * Production MVP — browser entry point.
 *
 * Decodes a crop's PNG/SVG data URL (e.g. the `imageDataUrl` captured on an
 * Area annotation) into the pure {@link GrayImage} the engine consumes, then
 * runs {@link recognizeCarbonSkeleton}. Decoding requires a DOM canvas 2D
 * context; in Node / jsdom callers should build a GrayImage directly and call
 * {@link recognizeCarbonSkeleton}. Nothing here touches the network.
 */

import { decodeImageDataUrlToGray } from "../../skeleton";
import {
  recognizeCarbonSkeleton,
  type RecognizeCarbonSkeletonOptions,
} from "./recognizeCarbonSkeleton";
import type { CarbonSkeletonRecognition } from "./types";

/**
 * Recognise the carbon skeleton from a crop data URL. Resolves to the same
 * discriminated {@link CarbonSkeletonRecognition} as the synchronous path; a
 * decode failure is reported as an explicit `unsupported` result rather than a
 * thrown error, so the UI has a single failure channel.
 */
export async function recognizeCarbonSkeletonFromDataUrl(
  imageDataUrl: string,
  options: RecognizeCarbonSkeletonOptions = {},
): Promise<CarbonSkeletonRecognition> {
  let gray;
  try {
    gray = await decodeImageDataUrlToGray(imageDataUrl);
  } catch (err) {
    return {
      success: false,
      status: "unsupported",
      confidence: 0,
      reason: `could not decode the crop image: ${String(err)}`,
      notes: [],
    };
  }
  return recognizeCarbonSkeleton(gray, options);
}
