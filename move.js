const fs = require('fs').promises;
const path = require('path');

const SOURCE_DIR = process.cwd(); // The current directory where the script is run
const DEST_DIR = 'AIContext';     // The name of the target folder

/**
 * Finds all .md files in the current directory and moves them to the AIContext folder.
 */
async function moveMarkdownFiles() {
    try {
        // 1. Create the destination folder if it doesn't exist
        await fs.mkdir(path.join(SOURCE_DIR, DEST_DIR), { recursive: true });
        console.log(`Ensured directory '${DEST_DIR}' exists.`);

        // 2. Read the contents of the current directory
        const files = await fs.readdir(SOURCE_DIR);

        let filesMoved = 0;
        
        // 3. Filter and process the files
        for (const file of files) {
            // Check if the file is a markdown file AND not the destination folder itself
            if (file.endsWith('.md') && file !== DEST_DIR) {
                const oldPath = path.join(SOURCE_DIR, file);
                const newPath = path.join(SOURCE_DIR, DEST_DIR, file);

                // 4. Move the file (fs.rename is used for moving files in Node.js)
                await fs.rename(oldPath, newPath);
                console.log(`✅ Moved: ${file} -> ${DEST_DIR}/${file}`);
                filesMoved++;
            }
        }

        if (filesMoved === 0) {
            console.log("🤷 No .md files found to move in the current directory.");
        } else {
            console.log(`\n🎉 Finished! Moved ${filesMoved} .md file(s) to the '${DEST_DIR}' folder.`);
        }

    } catch (error) {
        // Handle common errors like permission issues
        console.error("❌ An error occurred during the file operation:", error.message);
    }
}

// Execute the main function
moveMarkdownFiles();