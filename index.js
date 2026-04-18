const path = require("path");
const fs = require("fs");
const os = require("os");
const inquirer = require("inquirer").default;
const whenExit = require("when-exit").default;
const { getWallpaper, setWallpaper } = require("wallpaper");
const Watcher = require("watcher").default;
const lz4 = require("lz4");

const userHomeDir = process.env.HOME || process.env.USERPROFILE;
const zenGlobalFile = os.platform() === "win32" ?
  `${userHomeDir}/AppData/Roaming/zen/Profiles/` :
  `${userHomeDir}/Library/Application Support/zen/Profiles/`;
const defaultWallpapersDir = path.join(userHomeDir, "Documents/Wallpapers");

const args = process.argv.slice(2);
const verbose = args.includes("--verbose") || args.includes("-v");
const showHelp = args.includes("--help") || args.includes("-h");

if (showHelp) {
  console.log(`Usage: node index.js [options]
Options:
  --profile=<name>  Specify Zen profile to use
  --verbose, -v     Enable verbose logging
  --help, -h        Show this help message
`);
  process.exit(0);
}

const log = (...args) => {
  if (verbose) {
    console.log("[verbose]", ...args);
  }
};

const decompressMozLZ4 = (inputBuffer) => {
  let outputBuffer;
  if (!Buffer.isBuffer(inputBuffer)) {
    throw new Error("Input is not of type Buffer");
    return false;
  }
  if (inputBuffer.slice(0, 8).toString() !== "mozLz40\0") {
    throw new Error("Input does not seem to be jsonlz4 format");
    return false;
  }
  outputBuffer = Buffer.alloc(inputBuffer.readUInt32LE(8));
  lz4.decodeBlock(inputBuffer, outputBuffer, 12);
  return JSON.parse(outputBuffer.toString());
};

const getFileNameFromId = (id) => {
  // Remove { and } from id
  return id.replace(/{|}/g, "");
};

const setWallpaperForSpace = async (pathToImage) => {
  try {
    await setWallpaper(`.wallpapers/${getFileNameFromId(pathToImage)}`);
    console.log(`Wallpaper set to: ${pathToImage}`);
  } catch (err) {
    console.error(`Failed to set wallpaper: ${err.message}`);
  }
};

const watchPrefsFileAndUpdateWallpapers = (prefsFile) => {
  const watcher = new Watcher(prefsFile, { persistent: true, interval: 1000 });
  watcher.on("change", async () => {
    try {
      const prefsContent = fs.readFileSync(prefsFile, "utf-8");
      const spaceIdMatch = prefsContent.match(
        /user_pref\("zen.workspaces.active", "([^"]+)"\);/,
      );
      if (spaceIdMatch && spaceIdMatch[1]) {
        const activeSpaceId = spaceIdMatch[1];
        await setWallpaperForSpace(activeSpaceId);
      }
    } catch (err) {
      console.error(`Failed to update wallpaper: ${err.message}`);
    }
  });
};

const moveFileToWallpapersDir = (filePath, id) => {
  const wallpapersDir = path.join(__dirname, ".wallpapers");
  if (!fs.existsSync(wallpapersDir)) {
    fs.mkdirSync(wallpapersDir, { recursive: true });
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`File does not exist: ${filePath}`);
  }
  const destPath = path.join(wallpapersDir, getFileNameFromId(id));
  fs.copyFileSync(filePath, destPath);
  return destPath;
};

const runWithProfile = async (profileName) => {
  const profilePath = path.join(zenGlobalFile, profileName);
  const prefsFile = path.join(profilePath, "prefs.js");
  const sessionFile = path.join(profilePath, "zen-sessions.jsonlz4");

  let sessionFileContent;
  try {
    sessionFileContent = decompressMozLZ4(fs.readFileSync(sessionFile));
  } catch (err) {
    console.error(`Failed to read session file: ${err.message}`);
    process.exit(1);
  }

  let oldWallpaper;
  try {
    oldWallpaper = await getWallpaper();
    moveFileToWallpapersDir(oldWallpaper, "default");
  } catch (err) {
    console.log(`Failed to backup old wallpaper: ${err.message}`);
  }

  whenExit(async () => {
    if (oldWallpaper) {
      await setWallpaperForSpace("default");
      console.log("Restored old wallpaper.");
    }
  });

  const spaces = sessionFileContent.spaces;

  for (const space of spaces) {
    const defaultName = space.name.replace(/ /g, "").toLowerCase() + ".jpg";
    const defaultPath = path.join(defaultWallpapersDir, defaultName);
    if (fs.existsSync(defaultPath)) {
      space.default = defaultPath;
    }
  }

  inquirer
    .prompt([
      ...spaces.map((space, index) => ({
        type: "input",
        name: `space_${index}`,
        message: `Enter the image path for "${space.name}" (${space.uuid}) (Default current wallpaper):`,
        default: space.default ?? oldWallpaper,
      })),
    ])
    .then(async (answers) => {
      try {
        spaces.forEach((space, index) => {
          let imagePath = answers[`space_${index}`];
          imagePath = path.isAbsolute(imagePath) ? imagePath : path.join(defaultWallpapersDir, imagePath);
          const storedPath = moveFileToWallpapersDir(imagePath, space.uuid);
          space.wallpaperPath = storedPath;
          console.log(
            `Set wallpaper for space "${space.name}" to "${storedPath}"`,
          );
        });
        watchPrefsFileAndUpdateWallpapers(prefsFile);
        console.log("Watching for workspace changes...");
      } catch (err) {
        console.error(`Failed to process answers: ${err.message}`);
        process.exit(1);
      }
    });

  console.log("All wallpapers have been set.");
};

const start = async () => {
  const profileFromArgs = args.find(arg => arg.startsWith("--profile="));
  const profileName = profileFromArgs ? profileFromArgs.split("=")[1] : null;

  if (!fs.existsSync(zenGlobalFile)) {
    console.error(`Zen profiles directory not found: ${zenGlobalFile}`);
    process.exit(1);
  }

  log("Using Zen profiles directory:", zenGlobalFile);

  const availableProfiles = fs.readdirSync(zenGlobalFile).filter((file) => {
    return fs.statSync(path.join(zenGlobalFile, file)).isDirectory();
  });

  if (availableProfiles.length === 0) {
    console.error("No profiles found.");
    process.exit(1);
  }

  if (profileName && availableProfiles.includes(profileName)) {
    await runWithProfile(profileName);
  } else if (availableProfiles.length === 1) {
    await runWithProfile(availableProfiles[0]);
  } else if (profileName) {
    console.error(`Profile "${profileName}" not found. Available: ${availableProfiles.join(", ")}`);
    process.exit(1);
  } else {
    inquirer
      .prompt([
        {
          type: "rawlist",
          name: "profile",
          message:
            "Select a Zen profile to use for wallpaper (about:support to see current profile):",
          choices: availableProfiles,
        },
      ])
      .then((answers) => {
        runWithProfile(answers.profile);
      });
  }
};

start();
