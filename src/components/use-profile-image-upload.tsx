"use client";

import { useEffect, useState, type ChangeEvent } from "react";
import { ProfileImageCropDialog } from "./profile-image-crop-dialog";

/** Keep the approved crop separate from the picker, so cancelling never changes the upload. */
export function useProfileImageUpload(kind: "avatar" | "banner") {
  const [source, setSource] = useState<{ file: File; url: string } | null>(null);
  const [image, setImage] = useState<{ file: File; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sourceUrl = source?.url;
  const imageUrl = image?.url;
  const [removed, setRemoved] = useState(false);

  useEffect(() => () => { if (sourceUrl) URL.revokeObjectURL(sourceUrl); }, [sourceUrl]);
  useEffect(() => () => { if (imageUrl) URL.revokeObjectURL(imageUrl); }, [imageUrl]);

  function selectImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type)) {
      setError("Choose a PNG, JPEG, GIF, or WebP photo.");
      return;
    }
    if (!file.size || file.size > 5 * 1024 * 1024) {
      setError("Choose a photo smaller than 5 MB.");
      return;
    }
    setError(null);
    setSource({ file, url: URL.createObjectURL(file) });
  }

  return {
    file: image?.file,
    preview: imageUrl,
    selectImage,
    removed,
    clearImage() {
      setImage(null);
      setError(null);
      setRemoved(true);
    },
    error,
    cropDialog: source && (
      <ProfileImageCropDialog
        kind={kind}
        source={source}
        onCancel={() => setSource(null)}
        onApply={(file) => {
          setImage({ file, url: URL.createObjectURL(file) });
          setRemoved(false);
          setSource(null);
        }}
      />
    ),
  };
}
