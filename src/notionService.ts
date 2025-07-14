import { Client } from "@notionhq/client";
import type { PhotoData } from "@mentra/sdk";

/**
 * Initializes the Notion client using the secret stored in the environment variable `NOTION_API_SECRET`.
 * If the secret is not found, an error is thrown immediately to fail fast.
 */
const NOTION_API_SECRET =
  process.env.NOTION_API_SECRET ??
  (() => {
    throw new Error(
      "NOTION_API_SECRET is not set in the environment variables"
    );
  })();

/**
 * The ID of the Notion page (or database) you want to append content to. The environment
 * variable should be named `NOTION_PAGE_ID`.
 */
const NOTION_PAGE_ID = "22ebee785a0b8001a255c023a1a0d745";
const notion = new Client({ auth: NOTION_API_SECRET });

/**
 * Appends a paragraph block containing the provided text to the configured Notion page.
 *
 * @param text - The text content you want to save to Notion.
 * @throws If the Notion API call fails.
 */
export async function saveToNotion(text: string): Promise<void> {
  if (!text) {
    throw new Error("Text must be a non-empty string");
  }

  await notion.blocks.children.append({
    block_id: NOTION_PAGE_ID,
    children: [
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [
            {
              type: "text",
              text: {
                content: text,
              },
            },
          ],
        },
      },
    ],
  });
}

const NOTION_VERSION = "2022-06-28"; // required API version for file uploads

/**
 * Uploads an image to Notion-managed storage using the Direct Upload flow
 * and attaches it as an image block to the configured page.
 *
 * 1. Create a File Upload object (POST /v1/file_uploads)
 * 2. Send the binary to the provided upload_url
 * 3. Append an image block referencing the file_upload id
 */
export async function saveImageToNotion(
  photo: PhotoData,
  title?: string
): Promise<void> {
  if (!photo?.buffer) throw new Error("Invalid photo data provided");

  // 1⃣ Create a File Upload object
  const createRes = await fetch("https://api.notion.com/v1/file_uploads", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_API_SECRET}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(
      `Failed to create file upload: ${createRes.status} ${errText}`
    );
  }

  const uploadMeta = (await createRes.json()) as {
    id: string;
    upload_url: string;
  };

  // 2⃣ Send the file contents to Notion
  const form = new FormData();
  const filename = photo.filename || `photo_${Date.now()}`;
  form.append(
    "file",
    new Blob([photo.buffer], { type: photo.mimeType }),
    filename
  );

  const sendRes = await fetch(uploadMeta.upload_url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_API_SECRET}`,
      "Notion-Version": NOTION_VERSION,
      // NOTE: do NOT set Content-Type — letting fetch/FormData set boundaries automatically
    },
    body: form,
  });

  if (!sendRes.ok) {
    const errText = await sendRes.text();
    throw new Error(
      `Failed to upload file contents: ${sendRes.status} ${errText}`
    );
  }

  // Add title if provided
  if (title) {
    // Remove punctuation until first letter, capitalize first letter, and add "Title: " prefix
    const processedTitle = (() => {
      const trimmed = title.replace(/^[^a-zA-Z]*/, ""); // Remove non-letters from start
      if (trimmed.length === 0) return "Title: ";
      return "Title: " + trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    })();

    await notion.blocks.children.append({
      block_id: NOTION_PAGE_ID,
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: {
                  content: processedTitle,
                },
              },
            ],
          },
        },
      ],
    });
  }

  // 4⃣ Attach the uploaded file as an image block
  await notion.blocks.children.append({
    block_id: NOTION_PAGE_ID,
    // Cast to any until SDK types include file_upload support
    children: [
      {
        object: "block",
        type: "image",
        image: {
          type: "file_upload",
          file_upload: {
            id: uploadMeta.id,
          },
        },
      },
    ] as any,
  });

  // Save timestamp text right after the photo
  const timestamp = new Date().toLocaleString();
  await saveToNotion(`Photo captured at: ${timestamp}`);

  console.log("Image successfully saved to Notion");
}
