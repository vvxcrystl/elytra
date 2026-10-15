import "server-only";
import { readFileSync, statSync } from "node:fs";
import { createClassifier, type Classifier, type WeightFile } from "./linear";
import { moderationConfig } from "./config";

let cached: { path: string; classifier: Classifier } | undefined;
export function getClassifier(): Classifier {
  const path = moderationConfig().weights;
  if (cached?.path === path) return cached.classifier;
  if (statSync(path).size > 12 * 1024 * 1024) throw new Error("Moderation weights exceed size limit");
  const file = JSON.parse(readFileSync(path, "utf8")) as WeightFile;
  const classifier = createClassifier(file, Buffer.from(file.weights, "base64"));
  cached = { path, classifier };
  return classifier;
}
