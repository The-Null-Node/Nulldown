
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

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
  const { request, env, params } = context;
  const id = params.id;
  
  // Handle CORS preflight requests
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }
  
  // Only handle GET requests
  if (request.method !== "GET") {
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
    // Get the drop from R2 using the S3 client
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: `drops/${id}.json`,
      })
    );
    
    // Convert the stream to a string
    const bodyContents = await streamToString(response.Body);
    
    return new Response(
      bodyContents,
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  } catch (error) {
    console.error("Error getting drop:", error);
    
    // Check if the error is a NoSuchKey error (404)
    if (error.name === "NoSuchKey") {
      return new Response(
        JSON.stringify({ message: "Drop not found" }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }
    
    return new Response(
      JSON.stringify({ message: "Failed to get drop" }),
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

// Helper function to convert a stream to a string
async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
