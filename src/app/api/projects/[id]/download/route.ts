import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { db } from "@/db";
import { projects, tasks } from "@/db/schema";
import { eq, and, isNotNull } from "drizzle-orm";

/**
 * GET /api/projects/[id]/download — Download project output as a zip file
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const projectId = parseInt(id, 10);

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const outputDir = path.join(process.cwd(), "output", id);

  // Build a simple zip manually (using deflate-less zip for simplicity)
  const fileBuffers: { name: string; data: Buffer }[] = [];

  if (fs.existsSync(outputDir)) {
    // Read from disk (preferred - pipeline writes here during execution)
    const scanDir = (dir: string, prefix: string = "") => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name.endsWith(".bak")) continue;
        const fullPath = path.join(dir, entry.name);
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          scanDir(fullPath, relativePath);
        } else {
          if (entry.name.includes(".test.")) continue;
          fileBuffers.push({
            name: relativePath,
            data: fs.readFileSync(fullPath),
          });
        }
      }
    };
    scanDir(outputDir);
  } else {
    // Fall back to DB task outputs (fresh clone, no output/ folder on disk)
    const completedTasks = await db.query.tasks.findMany({
      where: and(
        eq(tasks.projectId, projectId),
        isNotNull(tasks.filePath),
        isNotNull(tasks.output),
      ),
    });
    for (const task of completedTasks) {
      if (!task.filePath || !task.output) continue;
      if (task.filePath.includes(".test.")) continue;
      fileBuffers.push({
        name: task.filePath,
        data: Buffer.from(task.output, "utf-8"),
      });
    }
  }

  if (fileBuffers.length === 0) {
    return NextResponse.json(
      { error: "No output files found" },
      { status: 404 },
    );
  }

  // Build zip using stored (no compression) method — keeps it dependency-free
  const zipParts: Buffer[] = [];
  const centralDir: Buffer[] = [];
  let offset = 0;

  for (const { name, data } of fileBuffers) {
    const nameBuffer = Buffer.from(name, "utf-8");
    const crc = crc32(data);

    // Local file header (30 bytes + name)
    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // compression: stored
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14); // crc32
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuffer.length, 26); // name length
    local.writeUInt16LE(0, 28); // extra field length
    nameBuffer.copy(local, 30);

    zipParts.push(local, data);

    // Central directory entry (46 bytes + name)
    const central = Buffer.alloc(46 + nameBuffer.length);
    central.writeUInt32LE(0x02014b50, 0); // signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // compression: stored
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0, 14); // mod date
    central.writeUInt32LE(crc, 16); // crc32
    central.writeUInt32LE(data.length, 20); // compressed size
    central.writeUInt32LE(data.length, 24); // uncompressed size
    central.writeUInt16LE(nameBuffer.length, 28); // name length
    central.writeUInt16LE(0, 30); // extra field length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // relative offset
    nameBuffer.copy(central, 46);

    centralDir.push(central);
    offset += local.length + data.length;
  }

  const centralDirBuffer = Buffer.concat(centralDir);
  const centralDirOffset = offset;

  // End of central directory (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central dir disk
  eocd.writeUInt16LE(fileBuffers.length, 8); // entries on disk
  eocd.writeUInt16LE(fileBuffers.length, 10); // total entries
  eocd.writeUInt32LE(centralDirBuffer.length, 12); // central dir size
  eocd.writeUInt32LE(centralDirOffset, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  const zipBuffer = Buffer.concat([...zipParts, centralDirBuffer, eocd]);

  const safeName = project.name.replace(/[^a-zA-Z0-9-_]/g, "_");

  return new NextResponse(zipBuffer, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${safeName}.zip"`,
    },
  });
}

/** Simple CRC-32 implementation */
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
