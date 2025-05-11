
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// Create an S3 client with explicit credentials
const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  // Disable loading credentials from shared ini file
  credentialDefaultProvider: () => () => Promise.resolve({
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  })
});

export async function onRequest(context) {
  const { request, env } = context;
  
  // Handle CORS preflight requests
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }
  
  // Only handle POST requests
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ message: "Method not allowed" }),
      {
        status: 405,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
  
  try {
    const body = await request.json();
    const { id, content } = body;
    
    if (!id || !content) {
      return new Response(
        JSON.stringify({ message: "Missing required fields" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }
    
    // Create metadata for the drop
    const dropData = {
      id,
      content,
      createdAt: new Date().toISOString(),
    };
    
    // Create a blob from the JSON string
    const blob = new Blob([JSON.stringify(dropData)], { type: 'application/json' });
    
    // Convert blob to buffer
    const buffer = await blob.arrayBuffer();
    
    // Store the drop in R2 using the S3 client
    await s3Client.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: `drops/${id}.json`,
        Body: buffer,
        ContentType: "application/json",
      })
    );
    
    return new Response(
      JSON.stringify({ success: true, id }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  } catch (error) {
    console.error("Error creating drop:", error);
    return new Response(
      JSON.stringify({ message: "Failed to create drop" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
}
