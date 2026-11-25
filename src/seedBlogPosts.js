/**
 * Seeds the Angelpage journal posts (src/seed/blogPosts.json).
 *
 *   npm run seed:blog
 *
 * Upserts by slug, so it is safe to run more than once: existing posts with
 * the same slug are updated, nothing else is touched. Posts are published
 * under the first admin account.
 */
const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");
const dotenv = require("dotenv");

dotenv.config();

const collection = name => mongoose.connection.collection(name);

async function seedBlogPosts() {
	const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
	if (!uri) {
		console.error("Missing MONGODB_URI / MONGO_URI");
		process.exit(1);
	}

	const file = path.join(__dirname, "seed", "blogPosts.json");
	const posts = JSON.parse(fs.readFileSync(file, "utf8"));

	await mongoose.connect(uri);

	const admin = await collection("admins").findOne({}, { projection: { _id: 1, firstName: 1, lastName: 1 } });
	if (!admin) {
		console.error("No admin account found. Create an admin first, then run this again.");
		await mongoose.disconnect();
		process.exit(1);
	}

	const now = new Date();
	let created = 0;
	let updated = 0;
	for (const post of posts) {
		const doc = {
			title: post.title,
			slug: post.slug.toLowerCase(),
			excerpt: post.excerpt || "",
			content: post.content || "",
			coverImage: post.coverImage || "",
			tags: post.tags || [],
			category: post.category || "stories",
			authorId: admin._id,
			authorRole: "ADMIN",
			authorName: post.authorName || "Angelpage Team",
			authorAvatar: post.authorAvatar || "",
			status: "published",
			publishedAt: post.publishedAt ? new Date(post.publishedAt) : now,
			featured: Boolean(post.featured),
			updatedAt: now,
		};
		const res = await collection("blogposts").updateOne(
			{ slug: doc.slug },
			{ $set: doc, $setOnInsert: { createdAt: now } },
			{ upsert: true },
		);
		if (res.upsertedCount) created += 1;
		else updated += 1;
		console.log(`${res.upsertedCount ? "Created" : "Updated"} ${doc.slug}`);
	}

	console.log(`Done. ${created} created, ${updated} updated.`);
	await mongoose.disconnect();
}

seedBlogPosts().catch(async err => {
	console.error(err);
	await mongoose.disconnect().catch(() => {});
	process.exit(1);
});
