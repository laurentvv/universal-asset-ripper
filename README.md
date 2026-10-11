# Universal Asset Ripper

[![Tests](https://img.shields.io/badge/tests-passing-brightgreen.svg)]()
[![Node](https://img.shields.io/badge/node-%3E%3D22.0.0-blue.svg)]()
[![License](https://img.shields.io/badge/license-MIT-green.svg)]()
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)]()

Extracteur, analyseur et orchestrateur multi-moteurs pour jeux vidéo (**Unity**, **Unreal Engine**, **Godot**) et **logiciels applicatifs Windows** (**Delphi**, **.NET**, **Electron**, **Qt**), intégrant l'assistance d'agents IA pour le reverse engineering via [morluto/rea](https://github.com/morluto/rea).

---

## 🎯 Fonctionnalités Clés

* 🔍 **Détection Automatique de Moteur & Framework (`ripper detect`) :**
  - Heuristiques de détection pour jeux (**Unity**, **Unreal Engine**, **Godot**).
  - Détection de frameworks applicatifs (**Delphi**, **.NET**, **Electron**, **Qt**, **Native C/C++**).
  - Détection de l'architecture PE (x86, x64, ARM64) et des conteneurs chiffrés.
* 📦 **Parseurs Binaires 100% Natifs :**
  - **Godot PCK :** Extraction directe des packages `.pck` et exécutables embarqués.
  - **Windows PE (.rsrc) :** Reconstruction d'icônes multi-résolutions `.ico`, extraction de formulaires Delphi (`.dfm`), manifests XML (`.xml`), bitmaps (`.bmp`), certificats et données RCDATA.
* 📊 **Inspection & Manifeste d'Assets (`ripper inspect`) :**
  - Inventaire catégorisé : textures, maillages 3D, audios, scènes, scripts, shaders, polices, formulaires, manifests.
* ⚡ **Extraction Ciblée (`ripper extract`) :**
  - Filtrage par catégories (`--categories texture,audio,mesh,config`) ou par motif (`--filter`).
  - Prise en charge des clés AES-256 (`--aes-key <hex>`) pour Unreal Engine.
* 🤖 **Analyse Binaire Assistée par IA (`ripper rea-inspect`) :**
  - Calcul de l'entropie de Shannon pour repérer les blocs de clés cryptographiques.
  - Recherche automatique de clés AES-256 dans les binaires x86/x64 (proximité S-Box Rijndael).
  - Détection et validation des métadonnées IL2CPP (`global-metadata.dat`).
  - Génération de bundles de preuves (*Evidence Bundles*) pour les agents REA.
* 🔌 **Serveur MCP Intégré (`ripper mcp`) :**
  - Expose les outils d'extraction aux agents IA (Claude Code, Gemini, Cursor, Antigravity).

---

## 🏗️ Architecture

```
                               ┌────────────────────────────────┐
                               │   Universal Asset Ripper       │
                               │   (CLI & Serveur MCP)          │
                               └──────────────┬─────────────────┘
                                              │
                    ┌─────────────────────────┴────────────────────────┐
                    ▼                                                  ▼
      [ Détecteur Automatique de Moteur ]                    [ Pont IA / Agent REA ]
  (Signatures: Unity, Unreal, Godot, Inconnu)            (morluto/rea - Reverse binaire,
                    │                                      recherche de clés, offsets)
       ┌────────────┼────────────┐
       ▼            ▼            ▼
 [ Adaptateur ] [ Adaptateur ] [ Adaptateur ]
    Unity           Unreal        Godot
 (AssetRipper)  (CUE4Parse/   (GDRE Tools /
                 repak/AES)     PCK Parser)
```

Pour plus de détails, consultez [docs/architecture.md](docs/architecture.md).

---

## 🚀 Installation & Démarrage

### Prérequis
* Node.js >= 22.0.0 (compatible v24.x)
* npm >= 10.0.0

### Installation
```bash
git clone https://github.com/laurentvv/universal-asset-ripper.git
cd universal-asset-ripper
npm install
npm run build
```

Pour utiliser la commande globale `ripper` :
```bash
npm link
```

---

## 💻 Utilisation CLI

### 1. Détecter le moteur d'un jeu
```bash
ripper detect "C:/Games/MyGame"
# ou directement sur un exécutable / package
ripper detect "C:/Games/MyGame/MyGame.exe"
```

### 2. Inspecter le contenu d'un jeu
```bash
ripper inspect "C:/Games/MyGame/game.pck"
```

### 3. Extraire des assets
```bash
# Extraction complète
ripper extract "C:/Games/MyGame" -o "./extracted"

# Extraction filtrée par type (textures et audios)
ripper extract "C:/Games/MyGame" -o "./extracted" --categories texture,audio

# Extraction Unreal avec clé AES
ripper extract "C:/Games/MyGame/Content/Paks/PakChunk0.pak" -o "./extracted" --aes-key 0x4A6B...
```

### 4. Scanner un binaire pour trouver des clés AES ou du code IL2CPP
```bash
ripper rea-inspect "C:/Games/MyGame/Game-Win64-Shipping.exe"
```

---

## 🤖 Configuration Serveur MCP (AI Agents)

Pour connecter Universal Asset Ripper à Claude Desktop, Cursor, Gemini CLI ou Antigravity, ajoutez cette configuration dans votre fichier `mcpServers` :

```json
{
  "mcpServers": {
    "universal-asset-ripper": {
      "command": "node",
      "args": ["C:/git/universal-asset-ripper/dist/cli/index.js", "mcp"]
    }
  }
}
```

### Outils exposés :
* `ripper_detect` : Analyse heuristique et détection du moteur.
* `ripper_inspect` : Manifeste complet des fichiers et catégories.
* `ripper_extract` : Extraction avec filtres et support AES.
* `ripper_scan_binary` : Détection automatique des clés AES et métadonnées IL2CPP.

---

## 📚 Documentation Technique

* 📘 [Architecture Détaillée](docs/architecture.md)
* 📗 [Guide Moteurs & Outils Spécialisés](docs/engines.md)
* 📙 [Guide d'Intégration REA & Agents IA](docs/rea-guide.md)

---

## 🧪 Tests

Le projet est testé avec [Vitest](https://vitest.dev/) sur des conteneurs synthétiques binaires :
```bash
npm test
```

---

## 📄 Licence

MIT © Laurent VOLFF
