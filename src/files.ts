/**
 * Shopify Files: where catalogue photos are kept. Shopify hosts them on its CDN with no expiry, whether or
 * not a product uses them. Needs the app scopes read_files and write_files.
 */
import type { Env } from "./types";
import { gql, ShopifyError } from "./shopify";
import { streamedBody } from "./streams";
import type { PhotoInfo } from "./catalogue";

export const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
/** Shopify's limit for images. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const enc = new TextEncoder();

type UserError = { field?: string[] | null; message: string };

/** Readable reason for a Files API refusal, pointing at the missing scope when that's the cause. */
function filesError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/access denied|write_files|read_files|not approved|scope/i.test(msg)) {
    return "The Shopify app can't use Files yet. Add the read_files and write_files scopes to the app, release a new version and reinstall it (see the README).";
  }
  return msg;
}

/** Shopify's image file names: letters, digits, dashes and dots. */
export function safeFileName(name: string, fallbackExt = "jpg"): string {
  const m = name.match(/^(.*?)(\.[A-Za-z0-9]{2,5})?$/);
  const stem = (m?.[1] ?? "photo").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "photo";
  const ext = (m?.[2] ?? `.${fallbackExt}`).toLowerCase();
  return `${stem}${ext}`;
}

/**
 * Upload one photo's bytes into Shopify Files, streamed straight through without being held in memory:
 * ask Shopify for an upload slot, post the bytes there, then create the file from it.
 */
export async function uploadImage(
  env: Env,
  p: { fileName: string; mimeType: string; size: number; stream: ReadableStream<Uint8Array>; alt: string },
): Promise<PhotoInfo> {
  const fileName = safeFileName(p.fileName, p.mimeType.split("/")[1] ?? "jpg");
  type S = {
    stagedUploadsCreate: {
      stagedTargets: { url: string; resourceUrl: string; parameters: { name: string; value: string }[] }[];
      userErrors: UserError[];
    };
  };
  let staged: S;
  try {
    staged = await gql<S>(
      env,
      `mutation Stage($input: [StagedUploadInput!]!) {
         stagedUploadsCreate(input: $input) {
           stagedTargets { url resourceUrl parameters { name value } }
           userErrors { field message }
         }
       }`,
      { input: [{ resource: "IMAGE", filename: fileName, mimeType: p.mimeType, httpMethod: "POST", fileSize: String(p.size) }] },
    );
  } catch (e) {
    throw new ShopifyError(filesError(e));
  }
  const target = staged.stagedUploadsCreate.stagedTargets[0];
  if (staged.stagedUploadsCreate.userErrors.length || !target) {
    throw new ShopifyError(filesError(staged.stagedUploadsCreate.userErrors.map((e) => e.message).join("; ") || "Shopify gave no upload slot."));
  }

  // multipart/form-data: Shopify's fields first, then the file.
  const boundary = `----price-savers-${crypto.randomUUID()}`;
  let head = "";
  for (const prm of target.parameters) {
    head += `--${boundary}\r\nContent-Disposition: form-data; name="${prm.name}"\r\n\r\n${prm.value}\r\n`;
  }
  head += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${p.mimeType}\r\n\r\n`;
  const { body, duplex } = streamedBody(enc.encode(head), p.stream, p.size, enc.encode(`\r\n--${boundary}--\r\n`));
  const up = await fetch(target.url, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
    ...(duplex ? { duplex } : {}),
  } as RequestInit);
  if (!up.ok) {
    const text = (await up.text().catch(() => "")).slice(0, 200);
    throw new ShopifyError(`Shopify's storage refused the photo (${up.status}). ${text}`.trim());
  }

  const [made] = await createFiles(env, [{ source: target.resourceUrl, fileName, alt: p.alt }]);
  if (!made || "error" in made) throw new ShopifyError(made?.error ?? "Shopify didn't create the file.");
  return made;
}

type FileNode = {
  id: string;
  fileStatus: "UPLOADED" | "PROCESSING" | "READY" | "FAILED";
  fileErrors?: { message: string }[];
  image?: { url: string } | null;
  url?: string | null;
};

const FILE_FIELDS = `id fileStatus fileErrors { message } ... on MediaImage { image { url } } ... on GenericFile { url }`;

function toInfo(n: FileNode): PhotoInfo & { error?: string } {
  const status = n.fileStatus === "READY" ? "ready" : n.fileStatus === "FAILED" ? "failed" : "processing";
  const url = n.image?.url ?? n.url ?? null;
  return {
    fileId: n.id,
    status: status === "ready" && !url ? "processing" : status,
    url,
    ...(status === "failed" ? { error: n.fileErrors?.map((e) => e.message).join("; ") || "Shopify couldn't process this photo." } : {}),
  };
}

/**
 * Create files from URLs (a photo link in a supplier export, or an upload slot). Shopify downloads each one
 * itself, so links that expire later don't matter once this has run. One bad link doesn't stop the others.
 */
export async function createFiles(
  env: Env,
  files: { source: string; fileName?: string; alt: string }[],
): Promise<((PhotoInfo & { error?: string }) | { error: string })[]> {
  if (!files.length) return [];
  type R = { fileCreate: { files: FileNode[] | null; userErrors: UserError[] } };
  const mutation = `mutation Make($files: [FileCreateInput!]!) {
     fileCreate(files: $files) { files { ${FILE_FIELDS} } userErrors { field message } }
   }`;
  const input = (f: (typeof files)[number]) => ({
    originalSource: f.source,
    contentType: "IMAGE",
    alt: f.alt.slice(0, 500),
    ...(f.fileName ? { filename: f.fileName } : {}),
  });
  let res: R;
  try {
    res = await gql<R>(env, mutation, { files: files.map(input) });
  } catch (e) {
    throw new ShopifyError(filesError(e));
  }
  if (!res.fileCreate.userErrors.length && res.fileCreate.files?.length === files.length) {
    return res.fileCreate.files.map(toInfo);
  }
  // Something in the batch was refused: try each on its own so we know which.
  if (files.length === 1) return [{ error: res.fileCreate.userErrors.map((e) => e.message).join("; ") || "Shopify refused this photo." }];
  const out: ((PhotoInfo & { error?: string }) | { error: string })[] = [];
  for (const f of files) out.push(...(await createFiles(env, [f])));
  return out;
}

/** Current status and CDN address of some files (Shopify processes new files in the background). */
export async function fileStatuses(env: Env, ids: string[]): Promise<(PhotoInfo & { error?: string })[]> {
  const out: (PhotoInfo & { error?: string })[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const part = ids.slice(i, i + 100);
    const data = await gql<{ nodes: (FileNode | null)[] }>(env, `query F($ids: [ID!]!) { nodes(ids: $ids) { ... on File { ${FILE_FIELDS} } } }`, { ids: part });
    part.forEach((id, j) => {
      const n = data.nodes[j];
      out.push(n && n.id ? toInfo(n) : { fileId: id, status: "deleted", url: null });
    });
  }
  return out;
}

export async function deleteFiles(env: Env, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  type R = { fileDelete: { deletedFileIds: string[] | null; userErrors: UserError[] } };
  const res = await gql<R>(env, `mutation Del($ids: [ID!]!) { fileDelete(fileIds: $ids) { deletedFileIds userErrors { message } } }`, { ids });
  const deleted = new Set(res.fileDelete.deletedFileIds ?? []);
  // A file someone already deleted in Shopify comes back as an error; it's gone either way.
  if (res.fileDelete.userErrors.length && !deleted.size) {
    const states = await fileStatuses(env, ids);
    for (const s of states) if (s.status === "deleted") deleted.add(s.fileId);
  }
  return [...deleted];
}

/**
 * Give an existing product copies of catalogue photos. Copies (not links to the catalogue's file) so that
 * deleting the product later can't take the catalogue's photo with it.
 */
export async function addPhotosToProduct(env: Env, productId: string, photos: { url: string; alt: string }[]): Promise<string | null> {
  type R = { productUpdate: { product: { id: string } | null; userErrors: UserError[] } };
  try {
    const res = await gql<R>(
      env,
      `mutation Add($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
         productUpdate(product: $product, media: $media) { product { id } userErrors { field message } }
       }`,
      { product: { id: productId }, media: photos.map((p) => ({ originalSource: p.url, mediaContentType: "IMAGE", alt: p.alt.slice(0, 500) })) },
    );
    if (res.productUpdate.userErrors.length || !res.productUpdate.product) {
      return res.productUpdate.userErrors.map((e) => e.message).join("; ") || "Shopify didn't add the photos.";
    }
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export interface ProductWithoutPhotos {
  productId: string;
  title: string;
  handle: string;
  vendor: string;
  barcode: string;
  sku: string;
}

/** Store products with no photo at all (first variant's barcode and SKU), for filling gaps from catalogues. */
export async function productsWithoutPhotos(env: Env): Promise<ProductWithoutPhotos[]> {
  type R = {
    products: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: {
        id: string;
        title: string;
        handle: string;
        vendor: string;
        featuredMedia: { id: string } | null;
        variants: { nodes: { barcode: string | null; sku: string | null }[] };
      }[];
    };
  };
  const out: ProductWithoutPhotos[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 40; page++) {
    const data: R = await gql<R>(
      env,
      `query P($cursor: String) {
         products(first: 250, after: $cursor) {
           pageInfo { hasNextPage endCursor }
           nodes { id title handle vendor featuredMedia { id } variants(first: 1) { nodes { barcode sku } } }
         }
       }`,
      { cursor },
    );
    for (const p of data.products.nodes) {
      if (p.featuredMedia) continue;
      const v = p.variants.nodes[0];
      out.push({ productId: p.id, title: p.title, handle: p.handle, vendor: p.vendor ?? "", barcode: v?.barcode ?? "", sku: v?.sku ?? "" });
    }
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }
  return out;
}

/** Cheap check that the app can see Files (i.e. has the read_files scope). */
export async function filesAccess(env: Env): Promise<string | null> {
  try {
    await gql(env, `{ files(first: 1) { nodes { id } } }`);
    return null;
  } catch (e) {
    return filesError(e);
  }
}
