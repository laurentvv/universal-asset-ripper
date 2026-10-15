//! French wording for the labels this clone invented (the original catalogues do not have them).
//! Only used when the active catalogue is French and does not know the English text.

pub fn lookup(s: &str) -> Option<&'static str> {
    let key = s.replace('&', "");
    FR.iter().find(|(en, _)| *en == key).map(|(_, fr)| *fr)
}

static FR: &[(&str, &str)] = &[
    ("1 to 2 years", "1 à 2 ans"),
    ("1 to 6 months", "1 à 6 mois"),
    ("2 to 5 years", "2 à 5 ans"),
    ("6 months to 1 year", "6 mois à 1 an"),
    ("After", "Après"),
    ("Administrator restart was cancelled or failed", "Le redémarrage en administrateur a été annulé ou a échoué"),
    ("Available when the scan has finished.", "Disponible une fois l'analyse terminée."),
    ("Before", "Avant"),
    ("Can be reclaimed", "Récupérable"),
    ("Category", "Catégorie"),
    ("Trend", "Évolution"),
    ("Changes since last scan", "Changements depuis la dernière analyse"),
    ("Clean-up", "Nettoyage"),
    ("Collapse this branch", "Réduire cette branche"),
    ("Compare with snapshot...", "Comparer avec un instantané..."),
    ("Compared with", "Comparé à"),
    ("Copy as path", "Copier en tant que chemin"),
    ("Count of sub-folders", "Nombre de sous-dossiers"),
    ("Delete", "Supprimer"),
    ("Delete (Recycle Bin)", "Supprimer (Corbeille)"),
    ("Difference", "Différence"),
    ("Empty folder", "Dossier vide"),
    ("Expand this branch", "Développer cette branche"),
    ("File age", "Ancienneté des fichiers"),
    ("Gradle cache", "Cache Gradle"),
    ("History", "Historique"),
    ("Invalid name", "Nom invalide"),
    ("Last 30 days", "30 derniers jours"),
    ("Level", "Niveau"),
    ("More than 5 years", "Plus de 5 ans"),
    ("New folder", "Nouveau dossier"),
    ("Next.js build cache", "Cache de build Next.js"),
    ("No earlier scan of this folder to compare with yet. Scan it again later, or use Compare with snapshot.", "Aucune analyse antérieure de ce dossier. Relancez l'analyse plus tard ou utilisez « Comparer avec un instantané »."),
    ("Node.js dependencies", "Dépendances Node.js"),
    ("NuGet cache", "Cache NuGet"),
    ("OK", "OK"),
    ("Open in Terminal", "Ouvrir dans le Terminal"),
    ("Parcel cache", "Cache Parcel"),
    ("Previous Windows installation", "Ancienne installation de Windows"),
    ("Python bytecode cache", "Cache bytecode Python"),
    ("Recent", "Récents"),
    ("Recycle Bin", "Corbeille"),
    ("Rename", "Renommer"),
    ("Rescan Folder", "Réanalyser le dossier"),
    ("Restart as Administrator", "Redémarrer en administrateur"),
    ("Rust build output", "Sortie de compilation Rust"),
    ("Save snapshot...", "Enregistrer un instantané..."),
    ("Select a folder, then delete it. Nothing is removed without confirmation.", "Sélectionnez un dossier puis supprimez-le. Rien n'est supprimé sans confirmation."),
    ("Size by last modification", "Taille selon la dernière modification"),
    ("Snapshot saved", "Instantané enregistré"),
    ("Windows properties", "Propriétés Windows"),
    ("Windows upgrade leftovers", "Restes de mise à niveau Windows"),
    ("Candidates by size while the scan runs; hashing starts when it ends.", "Candidats par taille pendant l'analyse ; le calcul des empreintes démarre à la fin."),
    ("Find duplicates", "Rechercher les doublons"),
    ("Groups files by size, then by a partial hash, then by a full BLAKE3 hash.", "Regroupe les fichiers par taille, puis par empreinte partielle, puis par empreinte BLAKE3 complète."),
    ("Keep one copy of each, delete the rest", "Garder une copie de chaque, supprimer le reste"),
    ("Minimum size", "Taille minimale"),
    ("Rescan to refresh the tree.", "Réanalysez pour actualiser l'arborescence."),
    ("could not be deleted", "n'ont pas pu être supprimés"),
    ("copies", "copies"),
    ("duplicate groups", "groupes de doublons"),
    ("files hashed", "fichiers traités"),
    ("wasted", "gaspillés"),
    ("Applied at the next scan.", "Appliqué à la prochaine analyse."),
    ("Based on the layout of", "Inspiré de la présentation de"),
    ("Excluded folders", "Dossiers exclus"),
    ("Expand all", "Tout développer"),
    ("Export failed", "Échec de l'exportation"),
    ("Exported", "Exporté"),
    ("Fast NTFS scan (admin)", "Analyse NTFS rapide (admin)"),
    ("Light", "Clair"),
    ("Max", "Max"),
    ("Min", "Min"),
    ("Nothing to show", "Rien à afficher"),
    ("Path to scan", "Chemin à analyser"),
    ("Pick a drive or type a path, then press Scan.", "Choisissez un lecteur ou saisissez un chemin, puis lancez l'analyse."),
    ("Ready", "Prêt"),
    ("Remove", "Retirer"),
    ("Scan a folder first.", "Analysez d'abord un dossier."),
    ("Scan cancelled", "Analyse annulée"),
    ("Scan complete", "Analyse terminée"),
    ("Scan errors", "Erreurs d'analyse"),
    ("Scanning", "Analyse en cours"),
    ("Types", "Types"),
    ("Views", "Affichages"),
    ("of", "de"),
    ("on disk", "sur disque"),
    ("partial", "partiel"),
    ("text or *.jpg", "texte ou *.jpg"),
    ("free", "libres"),
    ("Show in tree", "Afficher dans l'arborescence"),
    ("Size over time", "Taille au fil du temps"),
    ("Dismiss", "Ignorer"),
    ("folders could not be read (access denied).", "dossiers n'ont pas pu être lus (accès refusé)."),
    ("changed folders", "dossiers modifiés"),
    ("deleted", "supprimé"),
    ("folders", "dossiers"),
    ("grew", "augmenté"),
    ("last scan", "dernière analyse"),
    ("mypy cache", "Cache mypy"),
    ("new", "nouveau"),
    ("pytest cache", "Cache pytest"),
    ("shrank", "diminué"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn english_keys_are_unique() {
        let mut keys: Vec<&str> = FR.iter().map(|(en, _)| *en).collect();
        keys.sort_unstable();
        assert!(keys.windows(2).all(|w| w[0] != w[1]), "duplicate English key");
    }

    #[test]
    fn lookup_ignores_accelerators() {
        assert_eq!(lookup("&Rename"), Some("Renommer"));
        assert_eq!(lookup("nope"), None);
    }
}

#[cfg(test)]
mod audit {
    /// Every `tr("literal")` of the sources must be known to the French catalogue or to `FR`.
    #[test]
    fn all_literal_labels_have_french() {
        let mut missing = std::collections::BTreeSet::new();
        let mut stack = vec![std::path::PathBuf::from("src")];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(d).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if p.extension().is_some_and(|x| x == "rs") {
                    let text = std::fs::read_to_string(&p).unwrap();
                    let mut rest = text.as_str();
                    while let Some(i) = rest.find("tr(\"") {
                        rest = &rest[i + 4..];
                        let Some(j) = rest.find('"') else { break };
                        let lit = &rest[..j];
                        if !lit.is_empty() && !matches!(lit, "%%" | "Totally invented label 42" | "literal") && !lit.contains('\\') && !crate::i18n::is_translated("fr", lit) && super::lookup(lit).is_none() {
                            missing.insert(lit.to_string());
                        }
                    }
                }
            }
        }
        assert!(missing.is_empty(), "no French for: {missing:#?}");
    }
}
