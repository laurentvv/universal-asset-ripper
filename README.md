# Universal Asset Ripper

Extracteur, analyseur et orchestrateur multi-moteurs pour jeux vidéo (**Unity**, **Unreal Engine**, **Godot**), intégrant l'assistance d'agents IA pour le reverse engineering via [morluto/rea](https://github.com/morluto/rea).

---

## 🎯 Objectif du Projet

Fournir une interface unifiée (CLI et serveur MCP) capable de :
1. **Détecter automatiquement le moteur** d'un jeu à partir de ses fichiers ou de son exécutable.
2. **Extraire et convertir les assets** (modèles 3D, textures, audios, scènes, scripts) dans des formats standards (FBX, glTF, OBJ, PNG, WAV).
3. **Piloter les meilleurs moteurs de reverse engineering spécialisés** :
   - **Unity :** Écosystème basé sur [AssetRipper](https://github.com/AssetRipper/AssetRipper).
   - **Unreal Engine :** Extraction des conteneurs `.pak`, `.utoc`, `.ucas` (via CUE4Parse / repak).
   - **Godot :** Extraction des packages `.pck` et restauration de scènes/scripts (via GDRE Tools / parseur PCK natif).
4. **Intégrer des agents de reverse engineering (REA) :** Analyse binaire en profondeur pour extraire des clés AES, décortiquer les packers personnalisés ou analyser le comportement d'exécutables compilés.

---

## 🏗️ Architecture Cible

```
                         ┌────────────────────────────────┐
                         │   Universal Asset Ripper       │
                         │   (CLI & Serveur MCP)          │
                         └──────────────┬─────────────────┘
                                        │
              ┌─────────────────────────┴────────────────────────┐
              ▼                                                  ▼
[ Détecteur Automatique de Moteur ]                    [ Pont IA / Agent REA ]
(Signatures: Unity, Unreal, Godot)                     (morluto/rea - Reverse binaire,
              │                                          recherche de clés, offsets)
 ┌────────────┼────────────┐
 ▼            ▼            ▼
[ Adaptateur ] [ Adaptateur ] [ Adaptateur ]
   Unity           Unreal        Godot
(AssetRipper)  (CUE4Parse /   (GDRE Tools /
                repak / AES)    PCK Parser)
```

---

## 📋 Spécifications & Plan d'Implémentation (Prompt Maître)

Ce plan est prêt à être fourni à un agent ou exécuté par étapes :

### Phase 1 : Initialisation du Dépôt & Environnement
- Définition de l'arborescence modulaire (`src/core`, `src/adapters`, `src/cli`, `src/rea`).
- Configuration des scripts de démarrage et de packaging.

### Phase 2 : Détecteur Automatique de Moteur (`EngineDetector`)
- Analyse heuristique de l'arborescence des fichiers du jeu :
  - **Unity :** `UnityPlayer.dll`, répertoires `*_Data`, `globalgamemanagers`, `data.unity3d`, `GameAssembly.dll`.
  - **Unreal Engine :** dossiers `Engine/Binaries`, dossiers `Content/Paks`, fichiers `.pak`, `.utoc`, `.ucas`.
  - **Godot :** présence de fichiers `.pck` ou signature binaire `GDPC` dans le binaire `.exe`.
- Détection de la version du moteur lorsque disponible.

### Phase 3 : Adaptateurs Spécifiques (`EngineAdapter`)
- **UnityAdapter :**
  - Parsing des conteneurs `.assets`, `.sharedassets` et AssetBundles.
  - Exportation vers formats 3D (glTF/FBX) et multimédias (PNG/WAV).
- **UnrealAdapter :**
  - Extraction des conteneurs `.pak`, `.utoc`, `.ucas`.
  - Gestion des clés de déchiffrement AES.
- **GodotAdapter :**
  - Lecture des en-têtes `GDPC` et extraction des ressources indexées.
  - Récupération des scènes et fichiers de ressources.

### Phase 4 : Intégration REA (`morluto/rea`)
- Connecteur avec `rea-agents` pour l'analyse binaire profonde :
  - Recherche automatisée de chaînes de caractères et clés de chiffrement (AES pour UE).
  - Analyse des symboles et structures de données inconnues.

### Phase 5 : Interface CLI & MCP
- Commandes principales :
  - `ripper detect <chemin>` : Identifie le moteur et affiche un diagnostic.
  - `ripper inspect <chemin>` : Liste les assets et leurs catégories.
  - `ripper extract <chemin> -o <dossier_sortie>` : Extrait les assets.
  - `ripper rea-inspect <exécutable>` : Lance l'agent REA sur le binaire.

---

## 🔗 Références & Projets Liés
- [AssetRipper](https://github.com/AssetRipper/AssetRipper) - Outil d'extraction et d'analyse Unity
- [morluto/rea](https://github.com/morluto/rea) - Reverse Engineer Anything (MCP pour agents IA)
- [CUE4Parse](https://github.com/FabianFG/CUE4Parse) - Parseur C# Unreal Engine packages
- [GDRE Tools](https://github.com/bruvzg/gdsdecomp) - Godot Reverse Engineering Tools
