const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

/**
 * electron-builder afterPack hook
 * Installs node_modules for agent-app and mcp-server inside the packaged Resources.
 */
exports.default = async function(context) {
    const resourcesDir = path.join(context.appOutDir, context.packager.config.productName + '.app', 'Contents', 'Resources');

    const subProjects = ['agent-app', 'mcp-server'];
    for (const project of subProjects) {
        const targetDir = path.join(resourcesDir, project);
        if (fs.existsSync(path.join(targetDir, 'package.json'))) {
            console.log(`  • installing ${project} dependencies in packaged app...`);
            execSync('npm install --omit=dev --ignore-scripts', { cwd: targetDir, stdio: 'inherit' });
        }
    }
};
