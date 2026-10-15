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
    ("Change", "Changement"),
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
